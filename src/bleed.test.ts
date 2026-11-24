import { describe, expect, it } from "vitest";
import { ownVoiceLevels } from "./bleed.ts";
import { planWindows, type AudioWindow } from "./segment.ts";

const SR = 16_000;
const LENGTH_S = 40;

/** A voice-like sound in the given [startS, endS) ranges: harmonics of `pitch` up to 4 kHz with syllables at 4 Hz. */
function voice(pitch: number, ranges: [number, number][]): Float64Array {
  const out = new Float64Array(LENGTH_S * SR);
  for (const [start, end] of ranges) {
    for (let i = start * SR; i < end * SR; i++) {
      const t = i / SR;
      let sample = 0;
      for (let k = 1; k * pitch < 4000; k++) sample += Math.sin(2 * Math.PI * k * pitch * t) / k;
      out[i] = 0.08 * sample * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
    }
  }
  return out;
}

/** The sound as a microphone hears it from the speakers: later, quieter, with two reflections. */
function echo(sound: Float64Array, delayS: number, gain: number): Float64Array {
  const out = new Float64Array(sound.length);
  for (const [extraS, weight] of [[0, 1], [0.03, 0.4], [0.09, 0.2]]) {
    const shift = Math.round((delayS + extraS) * SR);
    for (let i = Math.max(0, shift); i < sound.length + Math.min(0, shift); i++) out[i] += gain * weight * sound[i - shift];
  }
  return out;
}

/** The sum of the sounds plus a quiet noise floor. */
function mix(...sounds: Float64Array[]): Int16Array {
  let seed = 1;
  return Int16Array.from({ length: LENGTH_S * SR }, (_, i) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 2 ** 32 - 0.5) * 0.002;
    return Math.round(32767 * sounds.reduce((sum, sound) => sum + sound[i], noise));
  });
}

/** Seconds of the windows that lie inside the [startS, endS) range. */
function plannedSeconds(windows: AudioWindow[], [start, end]: [number, number]): number {
  let samples = 0;
  for (const window of windows) {
    for (const piece of window.pieces) {
      samples += Math.max(0, Math.min(piece.srcEnd, end * SR) - Math.max(piece.srcStart, start * SR));
    }
  }
  return samples / SR;
}

// The others talk three times. The user answers once in a pause and once over the last of them.
const OTHERS: [number, number][] = [[1, 7], [9, 15], [26, 34]];
const ALONE: [number, number] = [17, 22];
const OVER: [number, number] = [29, 31];
const others = voice(120, OTHERS);
const own = voice(210, [ALONE, OVER]);

describe("ownVoiceLevels", () => {
  it.each([
    ["shortly after", 0.04],
    ["long after", 0.3],
    ["before", -0.1],
  ])("drops the others that the microphone hears %s the others track, and keeps the user", async (_, delayS) => {
    const mic = mix(own, echo(others, delayS, 0.5));
    const windows = planWindows(mic, SR, undefined, await ownVoiceLevels(mic, mix(others), SR));

    expect(plannedSeconds(planWindows(mic, SR), [1, 7])).toBeGreaterThan(5);
    expect(plannedSeconds(windows, [0.5, 16])).toBe(0);
    expect(plannedSeconds(windows, [26, 28.5])).toBe(0);
    expect(plannedSeconds(windows, [31.5, 35])).toBe(0);
    expect(plannedSeconds(windows, ALONE)).toBeGreaterThan(4.9);
    expect(plannedSeconds(windows, OVER)).toBeGreaterThan(1.5);
  });

  it("follows an echo that gets louder during the recording", async () => {
    const louder = echo(others, 0.04, 0.5);
    for (let i = 20 * SR; i < louder.length; i++) louder[i] *= 4;
    const mic = mix(own, louder);
    const windows = planWindows(mic, SR, undefined, await ownVoiceLevels(mic, mix(others), SR));

    expect(plannedSeconds(windows, [26, 28.5])).toBe(0);
    expect(plannedSeconds(windows, [31.5, 35])).toBe(0);
    expect(plannedSeconds(windows, ALONE)).toBeGreaterThan(4.9);
  });

  it("keeps everything the user says with headphones, also while the others talk", async () => {
    const mic = mix(own);
    const windows = planWindows(mic, SR, undefined, await ownVoiceLevels(mic, mix(others), SR));

    expect(windows).toEqual(planWindows(mic, SR));
  });

  it("changes nothing when the others track is silent", async () => {
    const mic = mix(own);
    const windows = planWindows(mic, SR, undefined, await ownVoiceLevels(mic, new Int16Array(mic.length), SR));

    expect(windows).toEqual(planWindows(mic, SR));
  });
});
