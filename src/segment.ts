/**
 * Splits a track into Whisper-sized windows that contain only speech.
 *
 * Whisper always encodes 30 s of audio per call, so the number of calls sets the
 * cost. Speech regions are found by frame energy, then packed back to back
 * (separated by a short silence) into windows of at most MAX_WINDOW_S. Long
 * silences are never sent to the model, which both saves time and avoids
 * Whisper's habit of inventing text ("Thanks for watching!") on silence.
 */

import type { SpeakerTurn } from "./store.ts";

export const FRAME_S = 0.02;
/** Below Whisper's 30 s input so padding never truncates speech. */
const MAX_WINDOW_S = 28;
/** Pauses shorter than this stay inside one region (keeps sentences intact). */
const MERGE_GAP_S = 1;
/** Regions shorter than this are clicks or breaths, not words. */
const MIN_SPEECH_S = 0.2;
/** Context kept before and after each region so word onsets are not clipped. */
const PAD_S = 0.25;
/** Silence inserted between packed regions so Whisper sees a boundary. */
const JOIN_SILENCE_S = 0.5;
/** Speech threshold is the noise floor plus this margin... */
const THRESHOLD_MARGIN_DB = 10;
/** ...clamped so digital silence still needs real sound, and a track that is mostly speech still splits. */
const THRESHOLD_MIN_DB = -55;
const THRESHOLD_MAX_DB = -40;
export const SILENCE_DB = -100;
/** A speaker's piece shorter than this is too short to transcribe alone. */
const MIN_PIECE_S = 0.3;

/** A source range [srcStart, srcEnd) placed at dstStart in the window, in samples. */
export interface WindowPiece {
  srcStart: number;
  srcEnd: number;
  dstStart: number;
  /** Index of the speaker within the track. */
  speaker: number;
}

export interface AudioWindow {
  pieces: WindowPiece[];
  /** Window length in samples, including inserted silence. */
  length: number;
}

/** Loudness of every frame of `frameSamples` samples in dB, where full scale is 0 and silence is SILENCE_DB. */
export function frameEnergies(pcm: Int16Array, frameSamples: number): Float64Array {
  const count = Math.ceil(pcm.length / frameSamples);
  const db = new Float64Array(count);
  for (let frame = 0; frame < count; frame++) {
    const start = frame * frameSamples;
    const end = Math.min(pcm.length, start + frameSamples);
    let squares = 0;
    for (let i = start; i < end; i++) squares += (pcm[i] / 32768) ** 2;
    const rms = Math.sqrt(squares / (end - start));
    db[frame] = rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
  }
  return db;
}

function speechThreshold(db: Float64Array): number {
  const sorted = Float64Array.from(db).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)];
  return Math.min(THRESHOLD_MAX_DB, Math.max(THRESHOLD_MIN_DB, noiseFloor + THRESHOLD_MARGIN_DB));
}

/** Speech regions as [startFrame, endFrame) after merging short pauses and dropping blips. */
function speechRegions(db: Float64Array, threshold: number, frameS: number): [number, number][] {
  const mergeGap = Math.round(MERGE_GAP_S / frameS);
  const minSpeech = Math.round(MIN_SPEECH_S / frameS);
  const regions: [number, number][] = [];
  let start = -1;
  for (let frame = 0; frame <= db.length; frame++) {
    const loud = frame < db.length && db[frame] > threshold;
    if (loud && start < 0) start = frame;
    if (!loud && start >= 0) {
      const last = regions.at(-1);
      if (last && start - last[1] < mergeGap) last[1] = frame;
      else regions.push([start, frame]);
      start = -1;
    }
  }
  return regions.filter(([s, e]) => e - s >= minSpeech);
}

/**
 * Padded speech ranges [start, end) in samples, in time order, each at most maxSeconds long.
 * `levels` gives the loudness of every frame that counts as speech, when that is not all the sound in `pcm`.
 */
export function speechRanges(
  pcm: Int16Array,
  sampleRate: number,
  maxSeconds: number,
  levels?: Float64Array,
): [number, number][] {
  const frameSamples = Math.round(FRAME_S * sampleRate);
  const energies = frameEnergies(pcm, frameSamples);
  // The threshold comes from the whole sound: frames that `levels` silences would pull the noise floor down.
  const threshold = speechThreshold(energies);
  const db = levels ?? energies;
  const maxSamples = Math.round(maxSeconds * sampleRate);
  const pad = Math.round(PAD_S * sampleRate);

  // A range longer than the limit is cut at its quietest frame in the second half
  // of the allowed length so the cut lands in a pause where possible.
  const ranges: [number, number][] = [];
  for (const [startFrame, endFrame] of speechRegions(db, threshold, FRAME_S)) {
    let start = Math.max(0, startFrame * frameSamples - pad);
    const end = Math.min(pcm.length, endFrame * frameSamples + pad);
    while (end - start > maxSamples) {
      const firstFrame = Math.ceil((start + maxSamples / 2) / frameSamples);
      const lastFrame = Math.floor((start + maxSamples) / frameSamples) - 1;
      let cutFrame = lastFrame;
      for (let frame = firstFrame; frame <= lastFrame; frame++) if (db[frame] < db[cutFrame]) cutFrame = frame;
      const cut = cutFrame * frameSamples;
      ranges.push([start, cut]);
      start = cut;
    }
    ranges.push([start, end]);
  }
  return ranges;
}

interface SpeakerSpan {
  start: number;
  end: number;
  speaker: number;
}

/** Cuts one speech range where the speaker changes. Spans touch and cover the range. */
function splitBySpeaker(start: number, end: number, turns: readonly SpeakerTurn[], minSamples: number): SpeakerSpan[] {
  const touching = turns.filter((t) => t.start < end && t.end > start);
  if (touching.length === 0) return [{ start, end, speaker: 0 }];

  const inside = touching.flatMap((t) => [t.start, t.end]).filter((cut) => cut > start && cut < end);
  const cuts = [start, ...[...new Set(inside)].sort((a, b) => a - b), end];

  // Every turn boundary is a cut, so a turn that overlaps an interval covers all of it.
  const speakers: (number | undefined)[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    let winner: SpeakerTurn | undefined;
    for (const turn of touching) {
      if (turn.start <= cuts[i] && turn.end >= cuts[i + 1] && (!winner || turn.start >= winner.start)) winner = turn;
    }
    speakers.push(winner?.speaker ?? speakers.at(-1));
  }
  const firstKnown = speakers.find((speaker) => speaker !== undefined) ?? 0;

  const spans: SpeakerSpan[] = [];
  speakers.forEach((known, i) => {
    const speaker = known ?? firstKnown;
    const length = cuts[i + 1] - cuts[i];
    const last = spans.at(-1);
    if (last && (last.speaker === speaker || length < minSamples)) {
      last.end = cuts[i + 1];
    } else if (last && spans.length === 1 && last.end - last.start < minSamples) {
      last.end = cuts[i + 1];
      last.speaker = speaker;
    } else {
      spans.push({ start: cuts[i], end: cuts[i + 1], speaker });
    }
  });
  return spans;
}

/**
 * Without turns every piece has speaker 0. With turns, ranges are also cut where the speaker changes and each piece carries its speaker.
 * `levels` is passed on to `speechRanges`.
 */
export function planWindows(
  pcm: Int16Array,
  sampleRate: number,
  turns?: readonly SpeakerTurn[],
  levels?: Float64Array,
): AudioWindow[] {
  const maxSamples = Math.round(MAX_WINDOW_S * sampleRate);
  const join = Math.round(JOIN_SILENCE_S * sampleRate);
  const minPiece = Math.round(MIN_PIECE_S * sampleRate);

  const windows: AudioWindow[] = [];
  let current: AudioWindow | null = null;
  for (const [rangeStart, rangeEnd] of speechRanges(pcm, sampleRate, MAX_WINDOW_S, levels)) {
    const spans: SpeakerSpan[] = turns?.length
      ? splitBySpeaker(rangeStart, rangeEnd, turns, minPiece)
      : [{ start: rangeStart, end: rangeEnd, speaker: 0 }];
    for (const { start: srcStart, end: srcEnd, speaker } of spans) {
      const length = srcEnd - srcStart;
      if (current && current.length + join + length <= maxSamples) {
        current.pieces.push({ srcStart, srcEnd, dstStart: current.length + join, speaker });
        current.length += join + length;
      } else {
        current = { pieces: [{ srcStart, srcEnd, dstStart: 0, speaker }], length };
        windows.push(current);
      }
    }
  }
  return windows;
}

/** The window's audio as Whisper input: float samples, pieces separated by silence. */
export function renderWindow(pcm: Int16Array, window: AudioWindow): Float32Array {
  const audio = new Float32Array(window.length);
  for (const piece of window.pieces) {
    for (let i = piece.srcStart; i < piece.srcEnd; i++) audio[piece.dstStart + i - piece.srcStart] = pcm[i] / 32768;
  }
  return audio;
}

function toDestination(window: AudioWindow, seconds: number, sampleRate: number): number {
  return Math.max(0, Math.min(window.length, Math.round(seconds * sampleRate)));
}

/** The piece a window sample belongs to. A sample in inserted silence goes to the next piece for "start", the previous for "end". */
function pieceAt(window: AudioWindow, dst: number, edge: "start" | "end"): WindowPiece {
  if (edge === "start") {
    return window.pieces.find((p) => dst < p.dstStart + (p.srcEnd - p.srcStart)) ?? window.pieces.at(-1)!;
  }
  return window.pieces.findLast((p) => p.dstStart < dst) ?? window.pieces[0];
}

/**
 * Maps a time inside the window (seconds) back to recording time (seconds).
 * edge "start": a time in inserted silence maps to the next piece's start. edge "end": it maps to the previous piece's end.
 */
export function toSourceTime(window: AudioWindow, seconds: number, sampleRate: number, edge: "start" | "end"): number {
  const dst = toDestination(window, seconds, sampleRate);
  const piece = pieceAt(window, dst, edge);
  const offset = Math.max(0, Math.min(piece.srcEnd - piece.srcStart, dst - piece.dstStart));
  return (piece.srcStart + offset) / sampleRate;
}

/** Speaker of the piece that overlaps window time [startSeconds, endSeconds) the most. */
export function speakerAt(window: AudioWindow, startSeconds: number, endSeconds: number, sampleRate: number): number {
  const start = toDestination(window, startSeconds, sampleRate);
  const end = toDestination(window, endSeconds, sampleRate);
  let best: WindowPiece | undefined;
  let bestOverlap = 0;
  for (const piece of window.pieces) {
    const overlap = Math.min(end, piece.dstStart + (piece.srcEnd - piece.srcStart)) - Math.max(start, piece.dstStart);
    if (overlap > bestOverlap) {
      best = piece;
      bestOverlap = overlap;
    }
  }
  return (best ?? pieceAt(window, start, "start")).speaker;
}
