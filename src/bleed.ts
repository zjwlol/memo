/**
 * Tells the user's own voice from the computer audio that the microphone hears through the speakers.
 *
 * Without headphones the microphone records the other people too: a little later, quieter, and
 * coloured by the speakers and the room. The "others" track holds the same audio clean. For each
 * frequency band this predicts how much of the microphone energy the others track explains, and
 * takes it away. What is left is the user's own voice.
 */

import { FRAME_S, frameEnergies, SILENCE_DB } from "./segment.ts";

/** Samples per spectrum, centred on a frame: 32 ms at 16 kHz. */
const FFT_SIZE = 512;
/** Bins below this are rumble, not speech: 125 Hz at 16 kHz. */
const FIRST_BIN = 4;
/** Bins per band: 250 Hz at 16 kHz. */
const BAND_BINS = 8;
const BANDS = Math.floor((FFT_SIZE / 2 + 1 - FIRST_BIN) / BAND_BINS);

/** How far the microphone copy can be behind (positive) or ahead of the others track. */
const MIN_LAG_S = -0.2;
const MAX_LAG_S = 0.5;
/** The echo of a frame also covers the frame before it and the room's reverberation after it. */
const HOLD_BEFORE = 1;
const HOLD_AFTER = 12;
/** Energy the reverberation keeps from one frame to the next. */
const REVERB_DECAY = 0.6;

/** The echo gain is measured again for every block, over the block and its two neighbours, because the volume and the automatic microphone gain change. */
const BLOCK_S = 5;
/** A band's frame counts for the gain when it is within this factor of the band's loud level in the others track. */
const LOUD_FRACTION = 0.05;
const LOUD_QUANTILE = 0.95;
/** Fewer loud frames than this give no reliable gain. */
const MIN_LOUD_FRAMES = 50;
/** The gain is this quantile of the ratios: above the middle, so a gain that rises inside the blocks is covered. */
const GAIN_QUANTILE = 0.75;
/** A block's gain is at most this many times the gain of the whole track. More means the user talked over the others for most of the block. */
const MAX_GAIN_RISE = 10;
/** The predicted echo is this many times the measured echo, so a louder than usual echo is still covered. */
const OVERSUBTRACT = 4;
/** A frame is the user's own voice when at least this part of its energy is not echo. */
const MIN_OWN_FRACTION = 0.3;
/** Frames on each side that the own part is averaged over. */
const SMOOTH_FRAMES = 2;
/** Frames between two pauses of the long loops. */
const SLICE_FRAMES = 2048;

/** Lets the page handle input during a long computation. A timer would be throttled in a hidden tab. */
function pause(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => {
    port1.close();
    resolve();
  };
  port2.postMessage(null);
  return promise;
}

const bitReversed = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let reversed = 0;
  for (let bit = 1, value = i; bit < FFT_SIZE; bit <<= 1, value >>= 1) reversed = (reversed << 1) | (value & 1);
  return reversed;
});
const cosTable = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FFT_SIZE));
const sinTable = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / FFT_SIZE));
const hann = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));

/** In-place FFT of FFT_SIZE complex points given in bit-reversed order. */
function fft(re: Float64Array, im: Float64Array): void {
  for (let half = 1; half < FFT_SIZE; half <<= 1) {
    const step = FFT_SIZE / (2 * half);
    for (let start = 0; start < FFT_SIZE; start += 2 * half) {
      for (let k = 0; k < half; k++) {
        const cos = cosTable[k * step];
        const sin = sinTable[k * step];
        const a = start + k;
        const b = a + half;
        const real = re[b] * cos - im[b] * sin;
        const imag = re[b] * sin + im[b] * cos;
        re[b] = re[a] - real;
        im[b] = im[a] - imag;
        re[a] += real;
        im[a] += imag;
      }
    }
  }
}

/** Energy of every band of every frame, row-major frames by BANDS. */
async function bandEnergies(pcm: Int16Array, frameSamples: number, frames: number): Promise<Float32Array> {
  const energies = new Float32Array(frames * BANDS);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const lead = (FFT_SIZE - frameSamples) >> 1;
  for (let frame = 0; frame < frames; frame++) {
    if (frame % SLICE_FRAMES === SLICE_FRAMES - 1) await pause();
    const start = frame * frameSamples - lead;
    let silent = true;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = pcm[start + i] ?? 0;
      if (sample !== 0) silent = false;
      re[bitReversed[i]] = (sample / 32768) * hann[i];
    }
    if (silent) continue;
    im.fill(0);
    fft(re, im);
    for (let band = 0; band < BANDS; band++) {
      let energy = 0;
      const first = FIRST_BIN + band * BAND_BINS;
      for (let bin = first; bin < first + BAND_BINS; bin++) energy += re[bin] * re[bin] + im[bin] * im[bin];
      energies[frame * BANDS + band] = energy;
    }
  }
  return energies;
}

/** Frames the microphone is behind the reference: the shift at which their loudness over time agrees best. */
function findLag(mic: Float32Array, reference: Float32Array, frames: number): number {
  const envelope = (energies: Float32Array): Float64Array => {
    const out = new Float64Array(frames);
    let mean = 0;
    for (let frame = 0; frame < frames; frame++) {
      let sum = 0;
      for (let band = 0; band < BANDS; band++) sum += energies[frame * BANDS + band];
      out[frame] = Math.sqrt(sum);
      mean += out[frame] / frames;
    }
    for (let frame = 0; frame < frames; frame++) out[frame] -= mean;
    return out;
  };
  const micEnvelope = envelope(mic);
  const referenceEnvelope = envelope(reference);
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = Math.round(MIN_LAG_S / FRAME_S); lag <= Math.round(MAX_LAG_S / FRAME_S); lag++) {
    let score = 0;
    for (let frame = Math.max(0, -lag); frame < frames - Math.max(0, lag); frame++) {
      score += referenceEnvelope[frame] * micEnvelope[frame + lag];
    }
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  return best;
}

/** The reference as the microphone would hear it at gain 1: shifted by the lag and smeared over the reverberation. */
function heldReference(reference: Float32Array, frames: number, lag: number): Float32Array {
  const held = new Float32Array(frames * BANDS);
  for (let frame = 0; frame < frames; frame++) {
    for (let back = -HOLD_BEFORE; back <= HOLD_AFTER; back++) {
      const source = frame - lag - back;
      if (source < 0 || source >= frames) continue;
      const weight = back > 0 ? REVERB_DECAY ** back : 1;
      for (let band = 0; band < BANDS; band++) {
        const energy = reference[source * BANDS + band] * weight;
        if (energy > held[frame * BANDS + band]) held[frame * BANDS + band] = energy;
      }
    }
  }
  return held;
}

/** The GAIN_QUANTILE value of the first `count` entries, which this sorts. */
function gainOf(ratios: Float32Array, count: number): number {
  return ratios.subarray(0, count).sort()[Math.floor(GAIN_QUANTILE * (count - 1))];
}

/**
 * Echo gain of every band in every block, row-major blocks by BANDS: the ratio of microphone energy
 * to held reference energy while the reference is loud. The user talks over only a small part of
 * those frames, so the quantile is the echo alone. 0 where the reference is too quiet to tell.
 */
async function echoGains(
  mic: Float32Array,
  held: Float32Array,
  frames: number,
  blockFrames: number,
): Promise<Float32Array> {
  const blocks = Math.ceil(frames / blockFrames);
  const gains = new Float32Array(blocks * BANDS);
  const column = new Float32Array(frames);
  const ratios = new Float32Array(frames);
  const scratch = new Float32Array(Math.min(frames, 3 * blockFrames));
  for (let band = 0; band < BANDS; band++) {
    await pause();
    for (let frame = 0; frame < frames; frame++) column[frame] = held[frame * BANDS + band];
    const loud = LOUD_FRACTION * Float32Array.from(column).sort()[Math.floor(LOUD_QUANTILE * (frames - 1))];
    if (loud === 0) continue;

    // -1 marks a frame that is not loud.
    let loudFrames = 0;
    for (let frame = 0; frame < frames; frame++) {
      const isLoud = column[frame] >= loud;
      ratios[frame] = isLoud ? mic[frame * BANDS + band] / column[frame] : -1;
      if (isLoud) column[loudFrames++] = ratios[frame];
    }
    const overall = loudFrames >= MIN_LOUD_FRAMES ? gainOf(column, loudFrames) : 0;

    for (let block = 0; block < blocks; block++) {
      let count = 0;
      const end = Math.min(frames, (block + 2) * blockFrames);
      for (let frame = Math.max(0, (block - 1) * blockFrames); frame < end; frame++) {
        if (ratios[frame] >= 0) scratch[count++] = ratios[frame];
      }
      gains[block * BANDS + band] =
        count >= MIN_LOUD_FRAMES ? Math.min(gainOf(scratch, count), MAX_GAIN_RISE * overall) : overall;
    }
  }
  return gains;
}

/**
 * Loudness in dB of the user's own voice in every frame of `mic`, for `planWindows`. `reference` is the
 * track of the computer audio, recorded at the same time. A frame that is mostly echo of the reference
 * is silent. With headphones nothing is echo and the result is the loudness of `mic`.
 */
export async function ownVoiceLevels(mic: Int16Array, reference: Int16Array, sampleRate: number): Promise<Float64Array> {
  const frameSamples = Math.round(FRAME_S * sampleRate);
  const levels = frameEnergies(mic, frameSamples);
  const frames = levels.length;
  const micEnergies = await bandEnergies(mic, frameSamples, frames);
  const referenceEnergies = await bandEnergies(reference, frameSamples, frames);
  const held = heldReference(referenceEnergies, frames, findLag(micEnergies, referenceEnergies, frames));
  const blockFrames = Math.round(BLOCK_S / FRAME_S);
  const gains = await echoGains(micEnergies, held, frames, blockFrames);

  // Running sums of the whole and the own energy, so a fraction over several frames is two subtractions.
  const whole = new Float64Array(frames + 1);
  const own = new Float64Array(frames + 1);
  for (let frame = 0; frame < frames; frame++) {
    const block = Math.floor(frame / blockFrames);
    let wholeEnergy = 0;
    let ownEnergy = 0;
    for (let band = 0; band < BANDS; band++) {
      const energy = micEnergies[frame * BANDS + band];
      const echo = OVERSUBTRACT * gains[block * BANDS + band] * held[frame * BANDS + band];
      wholeEnergy += energy;
      if (energy > echo) ownEnergy += energy - echo;
    }
    whole[frame + 1] = whole[frame] + wholeEnergy;
    own[frame + 1] = own[frame] + ownEnergy;
  }
  for (let frame = 0; frame < frames; frame++) {
    const from = Math.max(0, frame - SMOOTH_FRAMES);
    const to = Math.min(frames, frame + SMOOTH_FRAMES + 1);
    const wholeEnergy = whole[to] - whole[from];
    const fraction = wholeEnergy > 0 ? (own[to] - own[from]) / wholeEnergy : 1;
    levels[frame] = fraction >= MIN_OWN_FRACTION ? levels[frame] + 10 * Math.log10(fraction) : SILENCE_DB;
  }
  return levels;
}
