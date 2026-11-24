import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";

export type Track = "me" | "others";
export const SAMPLE_RATE = 16_000;

export type SessionStatus = "recording" | "recorded" | "transcribing" | "transcribed";

export interface Session {
  id: string;
  createdAt: number;
  /** Samples recorded so far. Every track has this length. */
  samples: number;
  status: SessionStatus;
  /** Tracks recorded, in display order: ["me"] or ["others", "me"]. */
  tracks: Track[];
  /** Title the user typed. */
  title?: string;
  /** First words of the transcript, set when transcription finishes. */
  preview?: string;
  /** Names the user gave to speakers, keyed by speakerKey(). */
  speakerNames?: Record<string, string>;
  modelId?: string;
  error?: string;
}

/** One second (or the final partial second) of 16 kHz mono PCM for every recorded track. */
export interface ChunkRecord {
  sessionId: string;
  seq: number;
  me: ArrayBuffer;
  others?: ArrayBuffer;
}

/** Samples [start, end) of one track where one speaker talks. `speaker` is a 0-based index within the track. */
export interface SpeakerTurn {
  start: number;
  end: number;
  speaker: number;
}

export interface TranscriptLine {
  track: Track;
  speaker: number;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
}

/** Transcription of one window; stored per window so an interrupted run resumes. */
export interface WindowResult {
  sessionId: string;
  track: Track;
  index: number;
  lines: TranscriptLine[];
}

interface TurnsRecord {
  sessionId: string;
  track: Track;
  turns: SpeakerTurn[];
}

interface NotesDb extends DBSchema {
  sessions: { key: string; value: Session };
  chunks: { key: [string, number]; value: ChunkRecord };
  windows: { key: [string, Track, number]; value: WindowResult };
  turns: { key: [string, Track]; value: TurnsRecord };
}

let dbPromise: Promise<IDBPDatabase<NotesDb>> | null = null;

/** Version 1 had two fixed tracks and no speakers. */
async function migrateFromV1(tx: IDBPTransaction<NotesDb, StoreNames<NotesDb>[], "versionchange">): Promise<void> {
  let session = await tx.objectStore("sessions").openCursor();
  while (session) {
    await session.update({ ...session.value, tracks: ["others", "me"] });
    session = await session.continue();
  }
  let window = await tx.objectStore("windows").openCursor();
  while (window) {
    const lines = window.value.lines.map((line) => ({ ...line, speaker: 0 }));
    await window.update({ ...window.value, lines });
    window = await window.continue();
  }
}

function db(): Promise<IDBPDatabase<NotesDb>> {
  dbPromise ??= openDB<NotesDb>("note-poc", 2, {
    upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        database.createObjectStore("sessions", { keyPath: "id" });
        database.createObjectStore("chunks", { keyPath: ["sessionId", "seq"] });
        database.createObjectStore("windows", { keyPath: ["sessionId", "track", "index"] });
      }
      if (oldVersion < 2) database.createObjectStore("turns", { keyPath: ["sessionId", "track"] });
      // A failed migration aborts the upgrade so the version 1 data stays as it was.
      if (oldVersion === 1) migrateFromV1(tx).catch(() => tx.abort());
    },
  });
  return dbPromise;
}

/** Every key of a session in a store whose key starts with the session id. */
function sessionRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId], [sessionId, []]);
}

export async function createSession(tracks: Track[]): Promise<Session> {
  const session: Session = { id: crypto.randomUUID(), createdAt: Date.now(), samples: 0, status: "recording", tracks };
  await (await db()).put("sessions", session);
  return session;
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await db()).get("sessions", id);
}

export async function updateSession(id: string, patch: Partial<Omit<Session, "id">>): Promise<Session> {
  const tx = (await db()).transaction("sessions", "readwrite");
  const session = await tx.store.get(id);
  if (!session) throw new Error(`Session ${id} not found`);
  const updated = { ...session, ...patch };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export async function listSessions(): Promise<Session[]> {
  const sessions = await (await db()).getAll("sessions");
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(id: string): Promise<void> {
  const tx = (await db()).transaction(["sessions", "chunks", "windows", "turns"], "readwrite");
  await Promise.all([
    tx.objectStore("sessions").delete(id),
    tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Infinity])),
    tx.objectStore("windows").delete(sessionRange(id)),
    tx.objectStore("turns").delete(sessionRange(id)),
    tx.done,
  ]);
}

/** Stores one chunk and advances the session length in the same transaction. */
export async function appendChunk(chunk: ChunkRecord, samplesInChunk: number): Promise<void> {
  const tx = (await db()).transaction(["chunks", "sessions"], "readwrite");
  const sessions = tx.objectStore("sessions");
  const session = await sessions.get(chunk.sessionId);
  if (!session) throw new Error(`Session ${chunk.sessionId} not found`);
  await tx.objectStore("chunks").put(chunk);
  await sessions.put({ ...session, samples: chunk.seq * SAMPLE_RATE + samplesInChunk });
  await tx.done;
}

/** One track of a session as contiguous PCM, read chunk by chunk to avoid holding every record at once. */
export async function readTrack(session: Session, track: Track): Promise<Int16Array> {
  if (!session.tracks.includes(track)) throw new Error(`Session ${session.id} has no "${track}" track`);
  const pcm = new Int16Array(session.samples);
  const range = IDBKeyRange.bound([session.id, 0], [session.id, Infinity]);
  let cursor = await (await db()).transaction("chunks").store.openCursor(range);
  while (cursor) {
    const buffer = cursor.value[track];
    if (buffer) {
      const offset = cursor.value.seq * SAMPLE_RATE;
      // The last chunk may run past `samples` if the page died between the two writes; clip it.
      const room = Math.max(0, session.samples - offset);
      pcm.set(new Int16Array(buffer).subarray(0, room), offset);
    }
    cursor = await cursor.continue();
  }
  return pcm;
}

export async function putWindowResult(result: WindowResult): Promise<void> {
  await (await db()).put("windows", result);
}

export async function listWindowResults(sessionId: string): Promise<WindowResult[]> {
  return (await db()).getAll("windows", sessionRange(sessionId));
}

export async function clearWindowResults(sessionId: string): Promise<void> {
  await (await db()).delete("windows", sessionRange(sessionId));
}

export async function getTurns(sessionId: string, track: Track): Promise<SpeakerTurn[] | undefined> {
  return (await (await db()).get("turns", [sessionId, track]))?.turns;
}

export async function putTurns(sessionId: string, track: Track, turns: SpeakerTurn[]): Promise<void> {
  await (await db()).put("turns", { sessionId, track, turns });
}

export async function clearTurns(sessionId: string): Promise<void> {
  await (await db()).delete("turns", sessionRange(sessionId));
}

/** A session still marked `recording` when the page loads lost its recorder (reload or crash). */
export async function recoverInterruptedSessions(): Promise<void> {
  for (const session of await listSessions()) {
    if (session.status === "recording") await updateSession(session.id, { status: "recorded" });
  }
}
