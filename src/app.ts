import { AsrClient } from "./asr-client.ts";
import type { AsrDevice } from "./asr-protocol.ts";
import { getAsrModel, type AsrModel } from "./models.ts";
import { holdPriority } from "./priority.ts";
import { CaptureError, NoSharedAudioError, Recorder, type RecorderEvents } from "./recorder.ts";
import { canRecord, canShareAudio, checkGpu, hasStorageFor, MB_PER_RECORDED_HOUR } from "./setup.ts";
import {
  clearTurns,
  clearWindowResults,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  listWindowResults,
  readTrack,
  recoverInterruptedSessions,
  SAMPLE_RATE,
  updateSession,
  type Session,
  type Track,
  type TranscriptLine,
} from "./store.ts";
import { transcribeSession, type TranscribeProgress } from "./transcribe.ts";
import { buildTranscript, previewOf } from "./transcript.ts";
import { encodeWav, mixTracks } from "./wav.ts";

export type ModelStatus =
  | { kind: "checking" }
  /** `loaded` and `total` are bytes. */
  | { kind: "downloading"; loaded: number; total: number }
  | { kind: "loading" }
  | { kind: "ready"; device: AsrDevice }
  /** The user removed the download. It downloads again when a transcription needs it or the user picks a model. */
  | { kind: "removed" }
  | { kind: "error"; message: string };

export interface Notice {
  level: "warn" | "error";
  text: string;
  action?: { label: string; run: () => void };
}

export interface AppState {
  /** Newest first. */
  sessions: Session[];
  selectedId: string | null;
  /** Transcript of the selected session, from buildTranscript. */
  lines: TranscriptLine[];
  /** `startedAt` is a `performance.now()` time. */
  recording: { sessionId: string; startedAt: number } | null;
  /** True while a start or a stop is in flight. */
  recordBusy: boolean;
  includeComputerAudio: boolean;
  /** False when this browser cannot share tab or system audio. */
  canShareAudio: boolean;
  model: AsrModel;
  modelStatus: ModelStatus;
  transcribing: { sessionId: string; progress: TranscribeProgress | null } | null;
  /** Session ids waiting for transcription, in order. */
  queued: string[];
  /** Problems the user must see, most important first. Empty when all is well. */
  notices: Notice[];
}

const MODEL_KEY = "note-poc:model";
const COMPUTER_AUDIO_KEY = "note-poc:computer-audio";
const MB = 1024 * 1024;
/** Microphone RMS below this counts as silence. */
const SILENT_RMS = 0.001;
const SILENT_MS = 5000;

const state: AppState = {
  sessions: [],
  selectedId: null,
  lines: [],
  recording: null,
  recordBusy: false,
  includeComputerAudio: false,
  canShareAudio: canShareAudio(),
  model: getAsrModel(localStorage.getItem(MODEL_KEY)),
  modelStatus: { kind: "checking" },
  transcribing: null,
  queued: [],
  notices: [],
};

const listeners = new Set<() => void>();
const levelListeners = new Set<(levels: Record<Track, number>) => void>();

const supported = canRecord();
let micBlocked = false;
let storageLow = false;
/** A recording problem or a failed action. The next recording clears it. */
let problem: Notice | null = null;
let micSilent = false;
let noGpu = false;

let recorder: Recorder | null = null;
let modelLoad: Promise<void> | null = null;
/** Sessions whose old results are being cleared for a new transcription. */
const resetting = new Set<string>();

const asr = new AsrClient(() => {
  modelLoad = null;
  state.modelStatus = { kind: "checking" };
  notify();
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorNotice(text: string): Notice {
  return { level: "error", text };
}

function warnNotice(text: string): Notice {
  return { level: "warn", text };
}

function buildNotices(): Notice[] {
  const notices: Notice[] = [];
  if (!supported) notices.push(errorNotice("This browser cannot record. Use Chrome or Edge on a computer."));
  if (micBlocked) {
    notices.push(
      errorNotice(
        "The microphone is blocked. Click the icon in the address bar, allow the microphone, then press Record again.",
      ),
    );
  }
  if (storageLow) notices.push(errorNotice("Not enough browser storage. Use a normal window, not Incognito or Guest."));
  if (state.modelStatus.kind === "error") {
    notices.push({
      level: "error",
      text: `The speech model is not ready: ${state.modelStatus.message}`,
      action: { label: "Try again", run: warmModel },
    });
  }
  if (problem) notices.push(problem);
  if (micSilent) notices.push(warnNotice("The microphone is silent. Check the input device."));
  if (noGpu) notices.push(warnNotice("No graphics acceleration here, so transcription is slow."));
  return notices;
}

function notify() {
  state.notices = buildNotices();
  for (const listener of listeners) listener();
}

/** Shows a failed action as a notice, so no action rejects. Resolves to true when the action succeeded. */
async function guarded(what: string, action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    problem = errorNotice(`${what}: ${errorMessage(error)}`);
    notify();
    return false;
  }
}

function setModelStatus(status: ModelStatus) {
  state.modelStatus = status;
  notify();
}

async function loadModel(target: AsrModel): Promise<void> {
  try {
    const downloading = (await asr.missingFiles(target)).length > 0;
    setModelStatus(downloading ? { kind: "downloading", loaded: 0, total: target.sizeMB * MB } : { kind: "loading" });
    const { device } = await asr.load(target, (loaded, total) => {
      if (downloading) setModelStatus(loaded < total ? { kind: "downloading", loaded, total } : { kind: "loading" });
    });
    // The library only warns when Cache Storage rejects a file, and the model would then download on every visit.
    const notKept = await asr.missingFiles(target);
    if (notKept.length) {
      throw new Error(
        `The browser did not keep ${notKept.join(", ")}. Free up disk space or use a normal window, not Incognito or Guest.`,
      );
    }
    setModelStatus({ kind: "ready", device });
  } catch (error) {
    setModelStatus({ kind: "error", message: errorMessage(error) });
    throw error;
  }
  // Diarization loads the speaker models itself when this fails.
  void asr
    .prepareSpeakers()
    .catch((error: unknown) => console.warn("Speaker models did not load:", error))
    .then(async () => {
      // A load for a newer selection deletes the unused files itself.
      if (state.model.id === target.id) await asr.prune(target);
    })
    .catch((error: unknown) => console.warn("Unused model files were not deleted:", error));
}

/** Downloads the selected model when needed and loads it. Concurrent callers share one load. */
function ensureModel(): Promise<void> {
  if (state.modelStatus.kind === "ready") return Promise.resolve();
  if (!modelLoad) {
    const load: Promise<void> = loadModel(state.model).finally(() => {
      if (modelLoad === load) modelLoad = null;
    });
    modelLoad = load;
  }
  return modelLoad;
}

/** Loads the model in the background, then resumes a queue that a failed load stopped. */
function warmModel() {
  void ensureModel().then(pumpQueue, () => {});
}

async function reloadSessions() {
  state.sessions = await listSessions();
  if (state.selectedId && !state.sessions.some((session) => session.id === state.selectedId)) {
    state.selectedId = null;
    state.lines = [];
  }
  notify();
}

function replaceSession(session: Session) {
  state.sessions = state.sessions.map((old) => (old.id === session.id ? session : old));
  notify();
}

async function loadLines(id: string) {
  const lines = buildTranscript(await listWindowResults(id));
  if (state.selectedId !== id) return;
  state.lines = lines;
  notify();
}

async function select(id: string | null) {
  if (state.selectedId !== id) {
    state.selectedId = id;
    state.lines = [];
    notify();
  }
  if (id) await guarded("Could not open the recording", () => loadLines(id));
}

function enqueue(id: string) {
  if (state.transcribing?.sessionId !== id && !state.queued.includes(id)) state.queued = [...state.queued, id];
  notify();
  void pumpQueue();
}

/** Transcribes queued sessions one at a time. */
async function pumpQueue() {
  if (state.transcribing) return;
  const [id, ...rest] = state.queued;
  if (!id) return;
  state.queued = rest;
  state.transcribing = { sessionId: id, progress: null };
  notify();
  const releasePriority = holdPriority();
  try {
    await ensureModel();
  } catch {
    // The model error notice offers the retry that resumes the queue.
    releasePriority();
    state.queued = [id, ...state.queued];
    state.transcribing = null;
    notify();
    return;
  }
  try {
    const session = await getSession(id);
    if (session) {
      await transcribeSession(session, asr, state.model, (progress, result) => {
        state.transcribing = { sessionId: id, progress };
        notify();
        if (result && state.selectedId === id) void guarded("Could not read the transcript", () => loadLines(id));
      });
    }
  } catch {
    // transcribeSession stored the error on the session.
  }
  releasePriority();
  state.transcribing = null;
  await guarded("Could not load the recordings", reloadSessions);
  void pumpQueue();
}

function recorderEvents(sessionId: string): RecorderEvents {
  let lastSound: number | null = null;
  return {
    onLevel(levels) {
      for (const listener of levelListeners) listener(levels);
      const { recording } = state;
      if (recording?.sessionId !== sessionId || state.recordBusy) return;
      const now = performance.now();
      if (levels.me >= SILENT_RMS) lastSound = now;
      const silent = now - (lastSound ?? recording.startedAt) >= SILENT_MS;
      if (silent !== micSilent) {
        micSilent = silent;
        notify();
      }
    },
    onSourceEnded(track) {
      if (state.recording?.sessionId !== sessionId) return;
      void stopRecording(
        warnNotice(
          track === "others"
            ? "Sharing stopped, so the recording ended."
            : "The microphone disconnected, so the recording ended.",
        ),
      );
    },
    onError(error) {
      if (state.recording?.sessionId !== sessionId) return;
      const reason = errorNotice(`Saving audio failed: ${error.message}`);
      if (state.recordBusy) {
        // The last chunk failed while a stop was already running.
        problem = reason;
        notify();
      } else {
        void stopRecording(reason);
      }
    },
  };
}

/** Turns a failed start into the notice that tells the user what to do. Closing the share picker shows nothing. */
function showStartFailure(error: unknown) {
  if (error instanceof CaptureError) {
    const { cause } = error;
    const denied = cause instanceof Error && cause.name === "NotAllowedError" ? cause : null;
    if (error.track === "others" && denied) {
      if (/system/i.test(denied.message)) {
        problem = errorNotice(
          "macOS blocked screen recording for this browser. Allow it in System Settings, Privacy and Security, Screen and System Audio Recording, then reopen the browser.",
        );
      }
      return;
    }
    if (error instanceof NoSharedAudioError) {
      problem = errorNotice(error.message);
      return;
    }
    if (error.track === "me" && denied) {
      micBlocked = true;
      return;
    }
  }
  problem = errorNotice(`Could not start recording: ${errorMessage(error)}`);
}

async function startRecording() {
  state.recordBusy = true;
  problem = null;
  micBlocked = false;
  notify();
  const tracks: Track[] = state.includeComputerAudio ? ["others", "me"] : ["me"];
  let session: Session | null = null;
  try {
    session = await createSession(tracks);
    recorder = await Recorder.start(session.id, tracks, recorderEvents(session.id));
    state.recording = { sessionId: session.id, startedAt: performance.now() };
    state.sessions = [session, ...state.sessions];
    state.selectedId = session.id;
    state.lines = [];
  } catch (error) {
    if (session) {
      await deleteSession(session.id).catch((cause: unknown) => console.warn("Could not delete the unused session:", cause));
    }
    showStartFailure(error);
  } finally {
    state.recordBusy = false;
    notify();
  }
}

async function stopRecording(reason: Notice | null) {
  const active = recorder;
  const sessionId = state.recording?.sessionId;
  if (!active || !sessionId || state.recordBusy) return;
  state.recordBusy = true;
  if (reason) problem = reason;
  micSilent = false;
  notify();
  try {
    await active.stop().catch((error: unknown) => {
      problem = errorNotice(`Stopping failed: ${errorMessage(error)}`);
    });
    await updateSession(sessionId, { status: "recorded" });
  } catch (error) {
    problem = errorNotice(`Could not save the recording: ${errorMessage(error)}`);
  } finally {
    recorder = null;
    state.recording = null;
    state.recordBusy = false;
    notify();
  }
  await select(sessionId);
  await guarded("Could not load the recordings", reloadSessions);
  enqueue(sessionId);
}

/** Stores the first words of the transcript on transcribed sessions that have no title to show. */
async function backfillPreviews() {
  for (const session of state.sessions) {
    if (session.status !== "transcribed" || session.title !== undefined || session.preview !== undefined) continue;
    try {
      const preview = previewOf(buildTranscript(await listWindowResults(session.id)));
      if (preview !== undefined) replaceSession(await updateSession(session.id, { preview }));
    } catch (error) {
      console.warn("Could not set the title of a recording:", error);
    }
  }
}

async function init() {
  if (!supported) {
    // Every later step needs one of the missing APIs.
    notify();
    return;
  }
  state.includeComputerAudio = state.canShareAudio && localStorage.getItem(COMPUTER_AUDIO_KEY) === "1";
  notify();

  await guarded("Could not load the recordings", async () => {
    await recoverInterruptedSessions();
    await reloadSessions();
  });
  await backfillPreviews();
  const newest = state.sessions[0];
  if (newest && state.selectedId === null) await select(newest.id);

  const gpu = await checkGpu();
  noGpu = !gpu.available;
  if (localStorage.getItem(MODEL_KEY) === null) {
    state.model = getAsrModel(gpu.f16 ? "whisper-large-v3-turbo" : "whisper-small");
    // Saved so a later visit with a different GPU answer does not swap the model and download again.
    localStorage.setItem(MODEL_KEY, state.model.id);
  }
  try {
    storageLow = !(await hasStorageFor(state.model.sizeMB + MB_PER_RECORDED_HOUR));
  } catch (error) {
    console.warn("Could not check the browser storage:", error);
  }
  notify();

  warmModel();
  for (const session of state.sessions.toReversed()) {
    if (session.status === "transcribing" || (session.status === "recorded" && session.error === undefined)) {
      enqueue(session.id);
    }
  }
}

export const app: {
  /** Mutated in place. Read it inside a subscriber. */
  readonly state: AppState;
  /** The listener runs after every state change. The result removes it. */
  subscribe(listener: () => void): () => void;
  /** The listener runs about 10 times a second while recording. The result removes it. */
  onLevels(listener: (levels: Record<Track, number>) => void): () => void;
  init(): Promise<void>;
  /** Call directly from the click handler. */
  toggleRecording(): Promise<void>;
  /** Remembered in localStorage. */
  setIncludeComputerAudio(on: boolean): void;
  select(id: string | null): Promise<void>;
  /** An empty title clears it. */
  rename(id: string, title: string): Promise<void>;
  /** An empty name clears it. */
  renameSpeaker(id: string, key: string, name: string): Promise<void>;
  /** Clears windows, turns, error, and preview, then queues the session. */
  retranscribe(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Also starts the download when the status is "removed". */
  setModel(modelId: string): Promise<void>;
  removeModelDownload(): Promise<void>;
  /** The session's audio as one WAV, all tracks mixed. Rejects when the audio cannot be read. */
  audio(id: string): Promise<Blob>;
} = {
  state,

  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  onLevels(listener) {
    levelListeners.add(listener);
    return () => {
      levelListeners.delete(listener);
    };
  },

  init,

  async toggleRecording() {
    if (!supported || state.recordBusy) return;
    await (state.recording ? stopRecording(null) : startRecording());
  },

  setIncludeComputerAudio(on) {
    state.includeComputerAudio = on && state.canShareAudio;
    if (state.includeComputerAudio) localStorage.setItem(COMPUTER_AUDIO_KEY, "1");
    else localStorage.removeItem(COMPUTER_AUDIO_KEY);
    notify();
  },

  select,

  async rename(id, title) {
    await guarded("Could not rename the recording", async () => {
      replaceSession(await updateSession(id, { title: title.trim() || undefined }));
    });
  },

  async renameSpeaker(id, key, name) {
    await guarded("Could not rename the speaker", async () => {
      const session = await getSession(id);
      if (!session) return;
      const speakerNames = { ...session.speakerNames };
      const trimmed = name.trim();
      if (trimmed) speakerNames[key] = trimmed;
      else delete speakerNames[key];
      replaceSession(await updateSession(id, { speakerNames }));
    });
  },

  async retranscribe(id) {
    const { recording, transcribing, queued } = state;
    if (recording?.sessionId === id || transcribing?.sessionId === id || queued.includes(id) || resetting.has(id)) return;
    resetting.add(id);
    const cleared = await guarded("Could not start the transcription", async () => {
      await clearWindowResults(id);
      await clearTurns(id);
      if (state.selectedId === id) state.lines = [];
      replaceSession(await updateSession(id, { error: undefined, preview: undefined }));
    });
    resetting.delete(id);
    if (cleared) enqueue(id);
  },

  async remove(id) {
    if (state.recording?.sessionId === id || state.transcribing?.sessionId === id || resetting.has(id)) return;
    const wasSelected = state.selectedId === id;
    state.queued = state.queued.filter((queuedId) => queuedId !== id);
    await guarded("Could not delete the recording", async () => {
      await deleteSession(id);
      await reloadSessions();
    });
    if (wasSelected && state.selectedId === null) await select(state.sessions[0]?.id ?? null);
  },

  async setModel(modelId) {
    if (state.transcribing || modelLoad) return;
    const model = getAsrModel(modelId);
    if (model.id === state.model.id && state.modelStatus.kind === "ready") return;
    localStorage.setItem(MODEL_KEY, model.id);
    state.model = model;
    setModelStatus({ kind: "checking" });
    warmModel();
  },

  async removeModelDownload() {
    if (state.transcribing || modelLoad) return;
    // A transcription queued during the removal must load the model again.
    setModelStatus({ kind: "checking" });
    try {
      await asr.remove(state.model);
      if (!modelLoad) setModelStatus({ kind: "removed" });
    } catch (error) {
      if (!modelLoad) setModelStatus({ kind: "error", message: `The download was not removed. ${errorMessage(error)}` });
    }
  },

  async audio(id) {
    const session = await getSession(id);
    if (!session) throw new Error("This recording no longer exists.");
    const tracks = await Promise.all(session.tracks.map((track) => readTrack(session, track)));
    return encodeWav(mixTracks(tracks), SAMPLE_RATE);
  },
};
