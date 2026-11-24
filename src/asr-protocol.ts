import type { AsrModel } from "./models.ts";

/** One Whisper segment, seconds relative to the audio passed to `transcribe`. */
export interface AsrChunk {
  text: string;
  start: number;
  end: number | null;
}

export type AsrDevice = "webgpu" | "wasm";

/** One local speaker found in the audio passed to `speakers`. */
export interface SpeakerUnit {
  /** Seconds [start, end) relative to the submitted audio where this speaker talks, in time order. */
  turns: { start: number; end: number }[];
  /** L2-normalised voice embedding of this speaker's non-overlapped audio. null when there is under 0.5 s of it. */
  embedding: Float32Array | null;
}

export type AsrRequest =
  | { type: "status"; id: number; model: AsrModel }
  | { type: "remove"; id: number; model: AsrModel }
  | { type: "load"; id: number; model: AsrModel }
  | { type: "transcribe"; id: number; audio: Float32Array }
  | { type: "prepare-speakers"; id: number }
  | { type: "speakers"; id: number; audio: Float32Array }
  | { type: "prune"; id: number; keep: AsrModel };

export type AsrResponse =
  | { type: "status"; id: number; missing: string[] }
  | { type: "removed"; id: number }
  | { type: "loaded"; id: number; device: AsrDevice; loadMs: number }
  | { type: "transcribed"; id: number; chunks: AsrChunk[]; ms: number }
  | { type: "speakers-ready"; id: number }
  | { type: "speakers"; id: number; units: SpeakerUnit[]; ms: number }
  | { type: "pruned"; id: number; removed: number }
  | { type: "error"; id: number; message: string }
  | { type: "download"; id: number; loaded: number; total: number };
