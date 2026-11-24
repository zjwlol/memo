import { describe, expect, it } from "vitest";
import { planWindows, renderWindow, speakerAt, speechRanges, toSourceTime, type AudioWindow } from "./segment.ts";

const SR = 16_000;

/** Silence with -20 dBFS tone bursts at the given [startS, endS) ranges. */
function track(lengthS: number, bursts: [number, number][]): Int16Array {
  const pcm = new Int16Array(lengthS * SR);
  for (const [start, end] of bursts) {
    for (let i = start * SR; i < end * SR; i++) pcm[i] = Math.round(0.1 * 32767 * Math.sin((2 * Math.PI * 220 * i) / SR));
  }
  return pcm;
}

function covered(windows: AudioWindow[], sample: number): boolean {
  return windows.some((w) => w.pieces.some((p) => sample >= p.srcStart && sample < p.srcEnd));
}

describe("speechRanges", () => {
  it("cuts continuous speech into contiguous ranges of at most maxSeconds", () => {
    const ranges = speechRanges(track(35, [[0, 35]]), SR, 10);
    expect(ranges.length).toBeGreaterThanOrEqual(4);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(35 * SR);
    for (const [start, end] of ranges) expect(end - start).toBeLessThanOrEqual(10 * SR);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
  });
});

describe("planWindows", () => {
  it("returns no windows for silence", () => {
    expect(planWindows(new Int16Array(60 * SR), SR)).toEqual([]);
  });

  it("wraps one utterance with padding", () => {
    const windows = planWindows(track(10, [[3, 5]]), SR);
    expect(windows).toHaveLength(1);
    expect(windows[0].pieces).toEqual([{ srcStart: 2.75 * SR, srcEnd: 5.25 * SR, dstStart: 0, speaker: 0 }]);
  });

  it("keeps short pauses inside one piece", () => {
    const windows = planWindows(track(10, [[1, 2], [2.5, 4]]), SR);
    expect(windows).toHaveLength(1);
    expect(windows[0].pieces).toHaveLength(1);
  });

  it("splits continuous speech into windows of at most 28 s that cover it without gaps", () => {
    const windows = planWindows(track(75, [[0, 75]]), SR);
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(28 * SR);
    const pieces = windows.flatMap((w) => w.pieces);
    expect(pieces[0].srcStart).toBe(0);
    expect(pieces.at(-1)!.srcEnd).toBe(75 * SR);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].srcStart).toBe(pieces[i - 1].srcEnd);
  });

  it("packs separated utterances into few windows and drops the silence between them", () => {
    const bursts: [number, number][] = Array.from({ length: 20 }, (_, i) => [i * 10, i * 10 + 2]);
    const pcm = track(200, bursts);
    const windows = planWindows(pcm, SR);
    // 20 × 2.5 s padded speech + joins fits in 3 windows; the 160 s of silence is never sent.
    expect(windows.length).toBe(3);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(28 * SR);
    for (const [start, end] of bursts) {
      expect(covered(windows, start * SR)).toBe(true);
      expect(covered(windows, end * SR - 1)).toBe(true);
    }
    expect(covered(windows, 6 * SR)).toBe(false);
  });

  it("ignores blips shorter than a word", () => {
    expect(planWindows(track(10, [[5, 5.1]]), SR)).toEqual([]);
  });
});

describe("planWindows with speaker turns", () => {
  const pcm = track(10, [[2, 8]]);

  it("treats an empty turn list like no turns", () => {
    expect(planWindows(pcm, SR, [])).toEqual(planWindows(pcm, SR));
  });

  it("splits a burst where the speaker changes and separates the pieces with silence", () => {
    const windows = planWindows(pcm, SR, [
      { start: 0, end: 5 * SR, speaker: 0 },
      { start: 5 * SR, end: 10 * SR, speaker: 1 },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].pieces).toEqual([
      { srcStart: 1.75 * SR, srcEnd: 5 * SR, dstStart: 0, speaker: 0 },
      { srcStart: 5 * SR, srcEnd: 8.25 * SR, dstStart: 3.75 * SR, speaker: 1 },
    ]);
    expect(windows[0].length).toBe(7 * SR);
  });

  it("merges a sliver of another speaker into the surrounding turn", () => {
    const windows = planWindows(pcm, SR, [
      { start: 0, end: 10 * SR, speaker: 0 },
      { start: 5 * SR, end: 5 * SR + 0.1 * SR, speaker: 1 },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].pieces).toEqual([{ srcStart: 1.75 * SR, srcEnd: 8.25 * SR, dstStart: 0, speaker: 0 }]);
  });

  it("gives a range that starts before the first turn that turn's speaker", () => {
    const windows = planWindows(pcm, SR, [{ start: 3 * SR, end: 9 * SR, speaker: 1 }]);
    expect(windows).toHaveLength(1);
    expect(windows[0].pieces).toEqual([{ srcStart: 1.75 * SR, srcEnd: 8.25 * SR, dstStart: 0, speaker: 1 }]);
  });

  it("gives the overlapped part of two turns to the later-starting turn", () => {
    const [window] = planWindows(pcm, SR, [
      { start: 0, end: 6 * SR, speaker: 0 },
      { start: 4 * SR, end: 10 * SR, speaker: 1 },
    ]);
    expect(window.pieces.map((p) => [p.srcStart, p.srcEnd, p.speaker])).toEqual([
      [1.75 * SR, 4 * SR, 0],
      [4 * SR, 8.25 * SR, 1],
    ]);
  });
});

describe("renderWindow / toSourceTime", () => {
  const pcm = track(60, [[5, 7], [30, 33]]);
  const [window] = planWindows(pcm, SR);

  it("places pieces back to back with silence between", () => {
    expect(window.pieces).toHaveLength(2);
    const audio = renderWindow(pcm, window);
    expect(audio.length).toBe(window.length);
    const [first, second] = window.pieces;
    const gap = audio.subarray(first.srcEnd - first.srcStart, second.dstStart);
    expect(gap.length).toBe(0.5 * SR);
    expect(gap.every((s) => s === 0)).toBe(true);
  });

  it("maps window time back to recording time", () => {
    const [first, second] = window.pieces;
    expect(toSourceTime(window, 0, SR, "start")).toBe(first.srcStart / SR);
    expect(toSourceTime(window, 1, SR, "start")).toBe(first.srcStart / SR + 1);
    // A timestamp in the inserted silence starts the next piece.
    expect(toSourceTime(window, (second.dstStart - 100) / SR, SR, "start")).toBe(second.srcStart / SR);
    // The same timestamp as an end closes the previous piece.
    expect(toSourceTime(window, (second.dstStart - 100) / SR, SR, "end")).toBe(first.srcEnd / SR);
    expect(toSourceTime(window, 1, SR, "end")).toBe(first.srcStart / SR + 1);
    expect(toSourceTime(window, second.dstStart / SR + 2, SR, "start")).toBe(second.srcStart / SR + 2);
    expect(toSourceTime(window, 999, SR, "start")).toBe(second.srcEnd / SR);
  });

  it("picks the speaker of the piece with the larger overlap", () => {
    const burst = track(10, [[2, 8]]);
    const [split] = planWindows(burst, SR, [
      { start: 0, end: 5 * SR, speaker: 0 },
      { start: 5 * SR, end: 10 * SR, speaker: 1 },
    ]);
    // Pieces sit at 0 to 3.25 s and 3.75 to 7 s in the window.
    expect(speakerAt(split, 1, 4, SR)).toBe(0);
    expect(speakerAt(split, 3, 5, SR)).toBe(1);
    // A span inside the inserted silence belongs to the next piece.
    expect(speakerAt(split, 3.3, 3.6, SR)).toBe(1);
  });
});
