// AudioWorklet that turns two live inputs into aligned 16 kHz mono Int16 chunks.
// Input 0 = shared tab/screen audio ("others"), input 1 = microphone ("me").
// Both inputs are pulled by the same render clock, so chunk N of each track
// covers exactly the same time span.

interface WorkletProcessor {
  readonly port: MessagePort;
}

interface WorkletScope {
  sampleRate: number;
  AudioWorkletProcessor: new () => WorkletProcessor;
  registerProcessor(name: string, processor: new () => WorkletProcessor): void;
}

// AudioWorkletGlobalScope is not in the DOM lib; these three members are all this file uses.
const scope = globalThis as unknown as WorkletScope;

export interface ChunkMessage {
  type: "chunk";
  seq: number;
  samples: number;
  others: ArrayBuffer;
  me: ArrayBuffer;
  final: boolean;
}

export interface LevelMessage {
  type: "level";
  /** RMS over the last 100 ms, 0..1. */
  others: number;
  me: number;
}

export type RecorderMessage = ChunkMessage | LevelMessage;

const CHUNK_SAMPLES = scope.sampleRate; // 1 s
const LEVEL_SAMPLES = Math.round(scope.sampleRate / 10);
const TRACK_COUNT = 2;

class PcmRecorder extends scope.AudioWorkletProcessor {
  #buffers = [new Int16Array(CHUNK_SAMPLES), new Int16Array(CHUNK_SAMPLES)];
  #filled = 0;
  #seq = 0;
  #squares = [0, 0];
  #levelFrames = 0;
  #stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<string>) => {
      if (event.data !== "flush" || this.#stopped) return;
      this.#stopped = true;
      this.#emitChunk(true);
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.#stopped) return false;
    const frames = inputs[0]?.[0]?.length ?? inputs[1]?.[0]?.length ?? 128;
    let written = 0;
    while (written < frames) {
      const take = Math.min(frames - written, CHUNK_SAMPLES - this.#filled);
      for (let track = 0; track < TRACK_COUNT; track++) {
        const channels = inputs[track] ?? [];
        const out = this.#buffers[track];
        for (let i = 0; i < take; i++) {
          // Downmix to mono; an ended or disconnected input has no channels and records silence.
          let sum = 0;
          for (const channel of channels) sum += channel[written + i];
          const sample = channels.length ? sum / channels.length : 0;
          this.#squares[track] += sample * sample;
          out[this.#filled + i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
        }
      }
      this.#filled += take;
      written += take;
      if (this.#filled === CHUNK_SAMPLES) this.#emitChunk(false);
    }

    this.#levelFrames += frames;
    if (this.#levelFrames >= LEVEL_SAMPLES) {
      const message: LevelMessage = {
        type: "level",
        others: Math.sqrt(this.#squares[0] / this.#levelFrames),
        me: Math.sqrt(this.#squares[1] / this.#levelFrames),
      };
      this.port.postMessage(message);
      this.#squares = [0, 0];
      this.#levelFrames = 0;
    }
    return true;
  }

  #emitChunk(final: boolean) {
    const others = this.#buffers[0].slice(0, this.#filled).buffer;
    const me = this.#buffers[1].slice(0, this.#filled).buffer;
    const message: ChunkMessage = { type: "chunk", seq: this.#seq++, samples: this.#filled, others, me, final };
    this.port.postMessage(message, [others, me]);
    this.#filled = 0;
  }
}

scope.registerProcessor("pcm-recorder", PcmRecorder);
