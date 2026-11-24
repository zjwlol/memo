import workletUrl from "./pcm-recorder.worklet.ts?worker&url";
import type { ChunkMessage, RecorderMessage } from "./pcm-recorder.worklet.ts";
import { appendChunk, SAMPLE_RATE } from "./store.ts";
import type { ChunkRecord, Track } from "./store.ts";

/** A source could not be opened. `track` says which one and `cause` holds the browser's error. */
export class CaptureError extends Error {
  readonly track: Track;

  constructor(track: Track, message: string, cause?: unknown) {
    super(message, { cause });
    this.track = track;
  }
}

/**
 * What to do for each surface the share picker returns (`MediaTrackSettings.displaySurface`). Chrome's picker has an
 * audio switch under each list ("…tab audio" for tabs, "…system audio" for windows and screens); when it is off, the
 * share has no audio track.
 */
function noAudioMessage(surface: string | undefined): string {
  switch (surface) {
    case "browser":
      return 'The tab was shared without its audio. Share it again and turn on the "tab audio" switch at the bottom of Chrome\'s picker.';
    case "window":
    case "monitor":
      return `The ${surface === "window" ? "window" : "screen"} was shared without audio. Share it again and turn on the "system audio" switch at the bottom of Chrome's picker. No such switch? Share the meeting's tab instead.`;
    default:
      return "The share has no audio. Share it again and turn on the audio switch at the bottom of Chrome's picker.";
  }
}

/** The shared tab, window or screen has no audio track. Its track is "others". */
export class NoSharedAudioError extends CaptureError {
  /** The surface the user shared: "browser", "window", "monitor", or undefined when the browser does not say. */
  readonly surface: string | undefined;

  constructor(surface: string | undefined) {
    super("others", noAudioMessage(surface));
    this.surface = surface;
  }
}

/** Fields Chrome supports on getDisplayMedia that the DOM lib does not declare yet. */
interface ChromeDisplayMediaOptions extends DisplayMediaStreamOptions {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
  monitorTypeSurfaces?: "include" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  audioSelection?: "preferred";
}

/** Shared screen/tab audio: speech-processing filters off so other people's voices are recorded as-is. */
export function captureSharedAudio(): Promise<MediaStream> {
  const options: ChromeDisplayMediaOptions = {
    // Chrome requires a video track; keep it cheap. It is stopped once audio is confirmed.
    // The picker opens on its tab list: a tab is the one surface that carries audio on every desktop OS.
    video: { frameRate: 1, displaySurface: "browser" },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: "include",
    // A window shares the whole system's audio, so a meeting app is heard whichever of its processes plays the sound.
    windowAudio: "system",
    // Chrome turns the window and screen audio switches on up front; without this they start off.
    audioSelection: "preferred",
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  };
  return navigator.mediaDevices.getDisplayMedia(options);
}

export function captureMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export interface RecorderEvents {
  /** RMS 0..1 per track over the last 100 ms. A track that is not recorded reports 0. */
  onLevel(levels: Record<Track, number>): void;
  /** A source stopped by itself: the user ended the share, or the microphone went away. */
  onSourceEnded(track: Track): void;
  /** A chunk could not be stored. The recorder stores nothing more after this. */
  onError(error: Error): void;
}

/** How long stop() waits for the worklet's last chunk. */
const FLUSH_TIMEOUT_MS = 2000;

async function openSource(track: Track, capture: () => Promise<MediaStream>, message: string): Promise<MediaStream> {
  try {
    return await capture();
  } catch (cause) {
    throw new CaptureError(track, message, cause);
  }
}

async function release(streams: readonly MediaStream[], context: AudioContext | undefined): Promise<void> {
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
  if (context && context.state !== "closed") await context.close();
}

/** Records the microphone, and shared audio when asked, as aligned 16 kHz tracks, persisting one chunk per second. */
export class Recorder {
  #sessionId: string;
  #storeOthers: boolean;
  #events: RecorderEvents;
  #context: AudioContext;
  #node: AudioWorkletNode;
  #streams: MediaStream[];
  #writes = Promise.resolve();
  #writeFailed = false;
  #flushed = Promise.withResolvers<void>();
  #stopping: Promise<void> | null = null;

  private constructor(
    sessionId: string,
    storeOthers: boolean,
    events: RecorderEvents,
    context: AudioContext,
    node: AudioWorkletNode,
    streams: MediaStream[],
  ) {
    this.#sessionId = sessionId;
    this.#storeOthers = storeOthers;
    this.#events = events;
    this.#context = context;
    this.#node = node;
    this.#streams = streams;
  }

  /** Call from a click handler. Opens the share picker first when tracks include "others", then the microphone. Rejects with a CaptureError when a source cannot be opened. */
  static async start(sessionId: string, tracks: readonly Track[], events: RecorderEvents): Promise<Recorder> {
    if (!tracks.includes("me")) throw new Error("A recording needs the microphone track.");
    const withOthers = tracks.includes("others");
    const streams: MediaStream[] = [];
    let context: AudioContext | undefined;
    try {
      let sharedAudio: MediaStreamTrack | undefined;
      if (withOthers) {
        // The share picker comes first: it needs the click's user activation.
        const shared = await openSource("others", captureSharedAudio, "The computer audio could not be shared.");
        streams.push(shared);
        sharedAudio = shared.getAudioTracks()[0];
        if (!sharedAudio) throw new NoSharedAudioError(shared.getVideoTracks()[0]?.getSettings().displaySurface);
        // The audio track keeps running without video (verified in Chrome 155); stop video to save CPU.
        for (const track of shared.getVideoTracks()) track.stop();
      }

      const mic = await openSource("me", captureMic, "The microphone could not be opened.");
      streams.push(mic);

      // Run the graph at 16 kHz: Chrome resamples every source, so the worklet gets Whisper's rate directly.
      context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
      if (context.state === "suspended") await context.resume();
      await context.audioWorklet.addModule(workletUrl);
      // Input 0 is the shared audio and stays unconnected for a microphone-only recording; input 1 is the microphone.
      const node = new AudioWorkletNode(context, "pcm-recorder", { numberOfInputs: 2, numberOfOutputs: 0 });
      if (sharedAudio) context.createMediaStreamSource(new MediaStream([sharedAudio])).connect(node, 0, 0);
      context.createMediaStreamSource(mic).connect(node, 0, 1);

      const recorder = new Recorder(sessionId, withOthers, events, context, node, streams);
      node.port.onmessage = (event: MessageEvent<RecorderMessage>) => {
        const message = event.data;
        if (message.type === "level") events.onLevel({ others: message.others, me: message.me });
        else recorder.#persist(message);
      };
      sharedAudio?.addEventListener("ended", () => events.onSourceEnded("others"), { once: true });
      mic.getAudioTracks()[0]?.addEventListener("ended", () => events.onSourceEnded("me"), { once: true });
      return recorder;
    } catch (error) {
      await release(streams, context);
      throw error;
    }
  }

  #persist(message: ChunkMessage) {
    if (message.samples > 0) {
      const chunk: ChunkRecord = { sessionId: this.#sessionId, seq: message.seq, me: message.me };
      if (this.#storeOthers) chunk.others = message.others;
      this.#writes = this.#writes.then(async () => {
        // A chunk after a failed one would leave a gap in the stored audio.
        if (this.#writeFailed) return;
        try {
          await appendChunk(chunk, message.samples);
        } catch (error) {
          this.#writeFailed = true;
          this.#events.onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    if (message.final) this.#flushed.resolve();
  }

  /** Flushes the partial last second, waits for every chunk to be stored, and releases the devices. */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      try {
        this.#node.port.postMessage("flush");
        // A worklet that died or never ran sends no last chunk, so the wait is bounded.
        const timeout = Promise.withResolvers<void>();
        const timer = setTimeout(timeout.resolve, FLUSH_TIMEOUT_MS);
        await Promise.race([this.#flushed.promise, timeout.promise]);
        clearTimeout(timer);
        // Anything the worklet sends from here on would be stored after stop() resolved.
        this.#node.port.onmessage = null;
        await this.#writes;
        this.#node.disconnect();
      } finally {
        await release(this.#streams, this.#context);
      }
    })();
    return this.#stopping;
  }
}
