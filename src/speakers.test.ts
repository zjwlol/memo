import { describe, expect, it } from "vitest";
import type { SpeakerUnit } from "./asr-protocol.ts";
import { speechRanges } from "./segment.ts";
import { clusterEmbeddings, diarizeTrack } from "./speakers.ts";

const SR = 16_000;

/** Silence with -20 dBFS tone bursts at the given [startS, endS) ranges. */
function track(lengthS: number, bursts: [number, number][]): Int16Array {
  const pcm = new Int16Array(lengthS * SR);
  for (const [start, end] of bursts) {
    for (let i = start * SR; i < end * SR; i++) pcm[i] = Math.round(0.1 * 32767 * Math.sin((2 * Math.PI * 220 * i) / SR));
  }
  return pcm;
}

/** Unit vector along the given components. */
function voice(...components: number[]): Float32Array {
  const norm = Math.hypot(...components);
  return Float32Array.from(components, (c) => c / norm);
}

const ANNA = voice(1, 0.05, 0, 0);
const BEN = voice(0, 0.05, 1, 0);

/** Stands in for the worker: answers each call from `reply` and counts the calls. */
function fakeAsr(reply: (call: number, seconds: number) => SpeakerUnit[]) {
  return {
    calls: 0,
    async speakers(audio: Float32Array): Promise<SpeakerUnit[]> {
      return reply(this.calls++, audio.length / SR);
    },
  };
}

describe("clusterEmbeddings", () => {
  it("returns no labels for no embeddings", () => {
    expect(clusterEmbeddings([])).toEqual([]);
  });

  it("groups vectors by direction and numbers the groups by first appearance", () => {
    const embeddings = [voice(1, 0.1, 0), voice(1, 0, 0.1), voice(0, 1, 0.1), voice(0.1, 1, 0), voice(1, 0.1, 0.1)];
    expect(clusterEmbeddings(embeddings)).toEqual([0, 0, 1, 1, 0]);
  });

  it("puts near-identical vectors in one cluster", () => {
    const embeddings = [voice(1, 0, 0), voice(1, 0.01, 0), voice(1, 0, 0.01), voice(1, 0.01, 0.01)];
    expect(clusterEmbeddings(embeddings)).toEqual([0, 0, 0, 0]);
  });

  it("splits with a lower threshold what the default merges", () => {
    // 45 degrees apart is a cosine distance of about 0.29.
    const embeddings = [voice(1, 0), voice(1, 1)];
    expect(clusterEmbeddings(embeddings)).toEqual([0, 0]);
    expect(clusterEmbeddings(embeddings, 0.1)).toEqual([0, 1]);
  });

  it("ignores vector length", () => {
    const embeddings = [Float32Array.of(5, 0), Float32Array.of(0, 0.2), Float32Array.of(0.3, 0), Float32Array.of(0, 9)];
    expect(clusterEmbeddings(embeddings)).toEqual([0, 1, 0, 1]);
  });

  it("separates four voices among 1000 noisy embeddings", () => {
    let seed = 1;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const embeddings = Array.from({ length: 1000 }, (_, i) => {
      const e = Float32Array.from({ length: 256 }, () => 0.06 * (random() - 0.5));
      e[i % 4] += 1;
      return e;
    });
    expect(clusterEmbeddings(embeddings)).toEqual(embeddings.map((_, i) => i % 4));
  });
});

describe("diarizeTrack", () => {
  it("returns no turns for silence and never asks the worker", async () => {
    const asr = fakeAsr(() => [{ turns: [{ start: 0, end: 1 }], embedding: ANNA }]);
    expect(await diarizeTrack(new Int16Array(30 * SR), asr)).toEqual([]);
    expect(asr.calls).toBe(0);
  });

  it("gives one voice the same speaker in every range, whatever its local index", async () => {
    const pcm = track(20, [[1, 3], [10, 12]]);
    const ranges = speechRanges(pcm, SR, 10);
    expect(ranges).toHaveLength(2);
    const [[first], [second]] = ranges;
    const script: SpeakerUnit[][] = [
      [
        { turns: [{ start: 0, end: 1 }], embedding: ANNA },
        { turns: [{ start: 1, end: 2 }], embedding: BEN },
      ],
      [
        { turns: [{ start: 0, end: 1 }], embedding: voice(0, 0, 1, 0.05) },
        { turns: [{ start: 1, end: 2 }], embedding: voice(1, 0, 0, 0.05) },
      ],
    ];
    const asr = fakeAsr((call) => script[call]);
    expect(await diarizeTrack(pcm, asr)).toEqual([
      { start: first, end: first + SR, speaker: 0 },
      { start: first + SR, end: first + 2 * SR, speaker: 1 },
      { start: second, end: second + SR, speaker: 1 },
      { start: second + SR, end: second + 2 * SR, speaker: 0 },
    ]);
    expect(asr.calls).toBe(2);
  });

  it("gives a unit without an embedding the speaker of the nearest embedded unit", async () => {
    const pcm = track(10, [[1, 6]]);
    const [[start]] = speechRanges(pcm, SR, 10);
    const asr = fakeAsr(() => [
      { turns: [{ start: 0, end: 1 }], embedding: ANNA },
      { turns: [{ start: 3, end: 4 }], embedding: BEN },
      { turns: [{ start: 2.5, end: 2.75 }], embedding: null },
    ]);
    expect(await diarizeTrack(pcm, asr)).toEqual([
      { start, end: start + SR, speaker: 0 },
      { start: start + 2.5 * SR, end: start + 2.75 * SR, speaker: 1 },
      { start: start + 3 * SR, end: start + 4 * SR, speaker: 1 },
    ]);
  });

  it("uses one speaker when no unit has an embedding", async () => {
    const pcm = track(10, [[1, 6]]);
    const [[start]] = speechRanges(pcm, SR, 10);
    const asr = fakeAsr(() => [
      { turns: [{ start: 2, end: 3 }], embedding: null },
      { turns: [{ start: 0, end: 1 }], embedding: null },
    ]);
    expect(await diarizeTrack(pcm, asr)).toEqual([
      { start, end: start + SR, speaker: 0 },
      { start: start + 2 * SR, end: start + 3 * SR, speaker: 0 },
    ]);
  });

  it("sorts turns by start and numbers speakers by first appearance", async () => {
    const pcm = track(10, [[1, 6]]);
    const [[start]] = speechRanges(pcm, SR, 10);
    const asr = fakeAsr(() => [
      { turns: [{ start: 1.5, end: 2 }, { start: 3.5, end: 4 }], embedding: ANNA },
      { turns: [{ start: 0.5, end: 1 }, { start: 2.5, end: 3 }], embedding: BEN },
    ]);
    expect(await diarizeTrack(pcm, asr)).toEqual([
      { start: start + 0.5 * SR, end: start + SR, speaker: 0 },
      { start: start + 1.5 * SR, end: start + 2 * SR, speaker: 1 },
      { start: start + 2.5 * SR, end: start + 3 * SR, speaker: 0 },
      { start: start + 3.5 * SR, end: start + 4 * SR, speaker: 1 },
    ]);
  });

  it("clamps turns to their speech range", async () => {
    const pcm = track(20, [[1, 3], [10, 12]]);
    const ranges = speechRanges(pcm, SR, 10);
    const asr = fakeAsr((call) => [{ turns: [{ start: -1, end: 99 }], embedding: call === 0 ? ANNA : BEN }]);
    expect(await diarizeTrack(pcm, asr)).toEqual(ranges.map(([start, end], speaker) => ({ start, end, speaker })));
  });

  it("merges one voice across ranges that touch and reports progress up to the total", async () => {
    const pcm = track(25, [[0, 25]]);
    const ranges = speechRanges(pcm, SR, 10);
    expect(ranges.length).toBeGreaterThan(1);
    const asr = fakeAsr((_, seconds) => {
      expect(seconds).toBeLessThanOrEqual(10);
      return [{ turns: [{ start: 0, end: seconds }], embedding: ANNA }];
    });
    const progress: [number, number][] = [];
    const turns = await diarizeTrack(pcm, asr, (done, total) => progress.push([done, total]));

    expect(turns).toEqual([{ start: ranges[0][0], end: ranges.at(-1)![1], speaker: 0 }]);
    expect(progress).toHaveLength(ranges.length);
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThan(progress[i - 1][0]);
    const [done, total] = progress.at(-1)!;
    expect(done).toBe(total);
    expect(total).toBe(ranges.reduce((sum, [start, end]) => sum + end - start, 0) / SR);
  });
});
