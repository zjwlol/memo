import type { DataType } from "@huggingface/transformers";

/**
 * Whisper checkpoints, same Hugging Face repos oh-my-pi uses for local STT
 * (`onnx-community/whisper-*`), downloaded from the same endpoint:
 * https://huggingface.co/{repo}/resolve/{revision}/{file}.
 *
 * `revision` is pinned to a commit so the browser cache key (the full URL) is
 * stable and every file of a model comes from the same snapshot.
 *
 * dtypes were picked by benchmark on WebGPU (Chrome 155, M3 Pro, 28 s windows):
 * - turbo q4f16: ~4.7 s/window, exact transcript of the test meeting.
 * - small q4:    ~5.3 s/window, a few word errors ("rugbook", "chattel").
 * - small q8 (oh-my-pi's CPU choice): ~61 s/window, because int8 ops have no WebGPU kernels.
 */
export interface AsrModel {
  id: string;
  label: string;
  repo: string;
  revision: string;
  dtype: Record<"encoder_model" | "decoder_model_merged", DataType>;
  /**
   * Every file the worker loads for this `dtype`, relative to the repo root.
   * Used to check the browser cache directly: `ModelRegistry.is_pipeline_cached`
   * (transformers.js 4.3.1) resolves per-file dtypes by session key and reports
   * the wrong encoder file, and it fetches `config.json` at `main` regardless of `revision`.
   */
  files: readonly string[];
  /** Total download size of `files`. */
  sizeMB: number;
  /** Needs the WebGPU `shader-f16` feature. */
  needsF16: boolean;
}

export const ASR_TASK = "automatic-speech-recognition";

/** Transcription language. Fixed to English: auto-detect flips on short or noisy windows. */
export const ASR_LANGUAGE = "en";

const CONFIG_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];

export const ASR_MODELS: readonly AsrModel[] = [
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper large-v3-turbo (most accurate)",
    repo: "onnx-community/whisper-large-v3-turbo",
    revision: "360ebcde2559d60bb474678be3c1de9ef347d01a",
    dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" },
    files: [...CONFIG_FILES, "onnx/encoder_model_q4f16.onnx", "onnx/decoder_model_merged_q4f16.onnx"],
    sizeMB: 568,
    needsF16: true,
  },
  {
    id: "whisper-small",
    label: "Whisper small (smaller download, less accurate)",
    repo: "onnx-community/whisper-small",
    revision: "36050c46d777d46dc4b5f43f6d90574fc38f8732",
    dtype: { encoder_model: "q4", decoder_model_merged: "q4" },
    files: [...CONFIG_FILES, "onnx/encoder_model_q4.onnx", "onnx/decoder_model_merged_q4.onnx"],
    sizeMB: 303,
    needsF16: false,
  },
];

const DEFAULT_ASR_MODEL_ID = "whisper-large-v3-turbo";

export function getAsrModel(id: string | null): AsrModel {
  return ASR_MODELS.find((m) => m.id === id) ?? ASR_MODELS.find((m) => m.id === DEFAULT_ASR_MODEL_ID)!;
}

/** A speaker model pinned to one commit, for the same reason as `AsrModel.revision`. */
export interface SpeakerModel {
  repo: string;
  revision: string;
  dtype: DataType;
}

/** Says which of up to three local speakers talk in each frame of a 10 s window. */
export const SPEAKER_SEGMENTATION: SpeakerModel = {
  repo: "onnx-community/pyannote-segmentation-3.0",
  revision: "733a93b6473d019a773298e08cefa686894b1854",
  dtype: "fp32",
};

/** Turns one speaker's audio into a voice embedding. */
export const SPEAKER_EMBEDDING: SpeakerModel = {
  repo: "onnx-community/wespeaker-voxceleb-resnet34-LM",
  revision: "6a61a1833ff2583aabeba044f5c8221f00b67ceb",
  dtype: "fp32",
};
