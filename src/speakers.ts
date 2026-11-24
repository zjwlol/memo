/**
 * Who speaks when in one track.
 *
 * The worker finds the speakers of one short speech range at a time and numbers
 * them per range. Clustering their voice embeddings here gives each voice one
 * number for the whole track.
 */

import type { AsrClient } from "./asr-client.ts";
import type { SpeakerUnit } from "./asr-protocol.ts";
import { speechRanges } from "./segment.ts";
import { SAMPLE_RATE, type SpeakerTurn } from "./store.ts";

/** Longest audio the speaker models take per call. */
const MAX_RANGE_S = 10;
/** Cosine distance below which two voices count as the same speaker. */
const CLUSTER_THRESHOLD = 0.5;

/** One local speaker of one speech range, with its turns as [start, end) in track samples. */
interface Unit {
  turns: [number, number][];
  embedding: SpeakerUnit["embedding"];
}

/** Moves a unit's turns from seconds in the range to track samples, clamped to the range. */
function placeUnit(unit: SpeakerUnit, rangeStart: number, rangeEnd: number): Unit {
  const toSample = (seconds: number) =>
    Math.max(rangeStart, Math.min(rangeEnd, rangeStart + Math.round(seconds * SAMPLE_RATE)));
  const turns: [number, number][] = [];
  for (const turn of unit.turns) {
    const start = toSample(turn.start);
    const end = toSample(turn.end);
    if (end > start) turns.push([start, end]);
  }
  return { turns, embedding: unit.embedding };
}

/** Samples between the closest turns of two units, 0 when they overlap. */
function gapBetween(a: Unit, b: Unit): number {
  let gap = Infinity;
  for (const [aStart, aEnd] of a.turns) {
    for (const [bStart, bEnd] of b.turns) gap = Math.min(gap, Math.max(0, aStart - bEnd, bStart - aEnd));
  }
  return gap;
}

/** One track-wide speaker per unit. Units must be in time order. */
function assignSpeakers(units: readonly Unit[]): number[] {
  const speakers = new Array<number>(units.length).fill(0);
  const embedded: number[] = [];
  const embeddings: Float32Array[] = [];
  units.forEach((unit, i) => {
    if (!unit.embedding) return;
    embedded.push(i);
    embeddings.push(unit.embedding);
  });
  const clusters = clusterEmbeddings(embeddings);
  embedded.forEach((i, c) => {
    speakers[i] = clusters[c];
  });

  // A voice too short to embed takes the speaker of the embedded unit nearest in time.
  units.forEach((unit, i) => {
    if (unit.embedding) return;
    let nearest = Infinity;
    for (const j of embedded) {
      const gap = gapBetween(unit, units[j]);
      if (gap < nearest) {
        nearest = gap;
        speakers[i] = speakers[j];
      }
    }
  });
  return speakers;
}

/** Who speaks when in one track. Turns are in samples, sorted by start, speakers numbered from 0 by first appearance. Empty when the track has no speech. */
export async function diarizeTrack(
  pcm: Int16Array,
  asr: Pick<AsrClient, "speakers">,
  onProgress?: (doneSeconds: number, totalSeconds: number) => void,
): Promise<SpeakerTurn[]> {
  const ranges = speechRanges(pcm, SAMPLE_RATE, MAX_RANGE_S);
  const totalSamples = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
  let doneSamples = 0;

  const units: Unit[] = [];
  for (const [start, end] of ranges) {
    const audio = new Float32Array(end - start);
    for (let i = start; i < end; i++) audio[i - start] = pcm[i] / 32768;
    for (const found of await asr.speakers(audio)) {
      const unit = placeUnit(found, start, end);
      if (unit.turns.length > 0) units.push(unit);
    }
    doneSamples += end - start;
    onProgress?.(doneSamples / SAMPLE_RATE, totalSamples / SAMPLE_RATE);
  }

  units.sort((a, b) => a.turns[0][0] - b.turns[0][0]);
  const speakers = assignSpeakers(units);
  const turns = units
    .flatMap((unit, i) => unit.turns.map(([start, end]): SpeakerTurn => ({ start, end, speaker: speakers[i] })))
    .sort((a, b) => a.start - b.start);

  const merged: SpeakerTurn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last && last.speaker === turn.speaker && turn.start <= last.end) last.end = Math.max(last.end, turn.end);
    else merged.push(turn);
  }

  const numbers = new Map<number, number>();
  for (const turn of merged) {
    if (!numbers.has(turn.speaker)) numbers.set(turn.speaker, numbers.size);
    turn.speaker = numbers.get(turn.speaker)!;
  }
  return merged;
}

/** Cosine distance of every pair as a row-major n by n matrix. A zero vector is at distance 1 from everything. */
function cosineDistances(embeddings: readonly Float32Array[]): Float64Array {
  const n = embeddings.length;
  const norms = embeddings.map((e) => {
    let sum = 0;
    for (let d = 0; d < e.length; d++) sum += e[d] * e[d];
    return Math.sqrt(sum);
  });
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const a = embeddings[i];
    for (let j = i + 1; j < n; j++) {
      const b = embeddings[j];
      let dot = 0;
      for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
      const distance = 1 - dot / (norms[i] * norms[j] || 1);
      dist[i * n + j] = distance;
      dist[j * n + i] = distance;
    }
  }
  return dist;
}

/**
 * One cluster index per embedding, numbered from 0 by first appearance.
 *
 * Average-linkage agglomerative clustering: the two closest clusters merge
 * until no pair is closer than `threshold`.
 */
export function clusterEmbeddings(embeddings: readonly Float32Array[], threshold = CLUSTER_THRESHOLD): number[] {
  const n = embeddings.length;
  const dist = cosineDistances(embeddings);
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  /** The cluster each embedding is in, named by its lowest surviving row. */
  const cluster = Int32Array.from({ length: n }, (_, i) => i);
  /** Closest other active cluster of each active cluster, -1 when it is the only one. */
  const nearest = new Int32Array(n);

  const findNearest = (i: number): void => {
    let best = -1;
    for (let k = 0; k < n; k++) {
      if (k !== i && active[k] && (best < 0 || dist[i * n + k] < dist[i * n + best])) best = k;
    }
    nearest[i] = best;
  };
  for (let i = 0; i < n; i++) findNearest(i);

  for (;;) {
    let a = -1;
    let closest = threshold;
    for (let i = 0; i < n; i++) {
      if (!active[i] || nearest[i] < 0) continue;
      const distance = dist[i * n + nearest[i]];
      if (distance < closest) {
        closest = distance;
        a = i;
      }
    }
    if (a < 0) break;

    // Cluster b joins a. The new distances are the size-weighted average of the two old rows.
    const b = nearest[a];
    const sizeA = size[a];
    const sizeB = size[b];
    active[b] = 0;
    size[a] = sizeA + sizeB;
    for (let k = 0; k < n; k++) {
      if (cluster[k] === b) cluster[k] = a;
      if (!active[k] || k === a) continue;
      const distance = (sizeA * dist[a * n + k] + sizeB * dist[b * n + k]) / (sizeA + sizeB);
      dist[a * n + k] = distance;
      dist[k * n + a] = distance;
    }
    findNearest(a);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      if (nearest[k] === a || nearest[k] === b) findNearest(k);
      else if (dist[k * n + a] < dist[k * n + nearest[k]]) nearest[k] = a;
    }
  }

  const numbers = new Map<number, number>();
  return Array.from(cluster, (root) => {
    if (!numbers.has(root)) numbers.set(root, numbers.size);
    return numbers.get(root)!;
  });
}
