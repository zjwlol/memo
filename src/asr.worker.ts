import {
  AutoFeatureExtractor,
  AutoModel,
  AutoModelForAudioFrameClassification,
  AutoModelForSpeechSeq2Seq,
  AutoProcessor,
  AutomaticSpeechRecognitionPipeline,
  env,
  WhisperProcessor,
  WhisperTokenizer,
  type PreTrainedModel,
  type Processor,
  type ProgressInfo,
  type PyAnnoteProcessor,
} from "@huggingface/transformers";
import ortFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { AsrChunk, AsrDevice, AsrRequest, AsrResponse, SpeakerUnit } from "./asr-protocol.ts";
import { ASR_LANGUAGE, ASR_TASK, SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION, type AsrModel } from "./models.ts";

// Browser-only app: never probe /models/ on our own origin, always use the Hub.
// Downloads are cached in Cache Storage (`env.cacheKey`, "transformers-cache"),
// keyed by the full download URL; a cache hit never touches the network.
// Three library paths ask the Hub for file metadata even on a cache hit, so the worker avoids them:
// `pipeline()` and the tokenizer loader (`AutoTokenizer`, and `AutoProcessor` for Whisper) ask about `main`
// whatever the revision, and a model `from_pretrained` with a progress callback asks about its guessed file list.
env.allowLocalModels = false;

// Serve the ONNX Runtime WASM build from this origin; the default is the jsDelivr CDN.
env.backends.onnx.wasm!.wasmPaths = { mjs: ortFactoryUrl, wasm: ortWasmUrl };

const SAMPLE_RATE = 16_000;

/** A speaker with less non-overlapped audio than this gets no embedding. */
const MIN_EMBEDDING_SAMPLES = SAMPLE_RATE / 2;

interface Segmenter {
  model: PreTrainedModel;
  processor: PyAnnoteProcessor;
  /** Local speaker numbers per class id. None is no speech, one is a solo speaker, two is overlapped speech. */
  classSpeakers: number[][];
  /** Shorter audio gives the model no frame to classify. */
  minSamples: number;
}

interface Embedder {
  model: PreTrainedModel;
  processor: Processor;
}

interface LocalSpeaker {
  turns: { start: number; end: number }[];
  /** Pieces of the audio where only this speaker talks. */
  solo: Float32Array[];
  soloSamples: number;
}

let current: { modelId: string; device: AsrDevice; transcriber: AutomaticSpeechRecognitionPipeline } | null = null;
let segmenter: Segmenter | null = null;
let embedder: Embedder | null = null;

/** Files the speaker loaders read from each speaker repo. The fp32 model file has no suffix in its name. */
const SPEAKER_FILES = ["config.json", "preprocessor_config.json", "onnx/model.onnx"];

/** The URL transformers.js downloads `file` from, which is also its Cache Storage key. */
function modelFileUrl(model: Pick<AsrModel, "repo" | "revision">, file: string): string {
  const path = env.remotePathTemplate
    .replaceAll("{model}", model.repo)
    .replaceAll("{revision}", encodeURIComponent(model.revision));
  return `${env.remoteHost}${path}${file}`;
}

async function missingFiles(model: AsrModel): Promise<string[]> {
  const cache = await caches.open(env.cacheKey);
  const missing: string[] = [];
  for (const file of model.files) {
    if (!(await cache.match(modelFileUrl(model, file)))) missing.push(file);
  }
  return missing;
}

async function removeFiles(model: AsrModel): Promise<void> {
  if (current?.modelId === model.id) {
    await current.transcriber.dispose();
    current = null;
  }
  const cache = await caches.open(env.cacheKey);
  for (const file of model.files) await cache.delete(modelFileUrl(model, file));
}

/** Deletes every cached file the app does not need while `keep` is the selected model. Returns how many were deleted. */
async function prune(keep: AsrModel): Promise<number> {
  const needed = new Set(
    [
      ...keep.files.map((file) => modelFileUrl(keep, file)),
      ...[SPEAKER_SEGMENTATION, SPEAKER_EMBEDDING].flatMap((model) =>
        SPEAKER_FILES.map((file) => modelFileUrl(model, file)),
      ),
      // transformers.js caches the WASM build under these URLs, resolved against the worker's own URL.
      ortFactoryUrl,
      ortWasmUrl,
    ].map((url) => new URL(url, self.location.href).href),
  );
  const cache = await caches.open(env.cacheKey);
  let removed = 0;
  for (const request of await cache.keys()) {
    if (needed.has(new URL(request.url).href)) continue;
    if (await cache.delete(request)) removed++;
  }
  return removed;
}

/** Reads one JSON file of `model` from Cache Storage. A missing file is downloaded and stored first. */
async function readJsonFile(
  model: AsrModel,
  file: string,
  onFileProgress?: (file: string, loaded: number) => void,
): Promise<object> {
  const url = modelFileUrl(model, file);
  const cache = await caches.open(env.cacheKey);
  const cached = await cache.match(url);
  if (cached) return cached.json();
  const response: Response = await env.fetch(url);
  if (!response.ok) throw new Error(`Could not download ${file} (HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();
  onFileProgress?.(file, bytes.byteLength);
  try {
    await cache.put(url, new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }));
  } catch (error) {
    console.warn(`Could not store ${file} in the browser cache`, error);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Builds what `pipeline()` builds for a Whisper checkpoint, with every file read at the pinned revision.
 * Pass `onFileProgress` only while files are missing: it makes the library ask the Hub for file sizes.
 */
async function loadTranscriber(
  model: AsrModel,
  device: AsrDevice,
  onFileProgress?: (file: string, loaded: number) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const options = {
    revision: model.revision,
    progress_callback: onFileProgress
      ? (info: ProgressInfo) => {
          if (info.status === "progress") onFileProgress(info.file, info.loaded);
        }
      : undefined,
  };
  // The small parts load first, so a failure here leaves no model sessions behind.
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readJsonFile(model, "tokenizer.json", onFileProgress),
    readJsonFile(model, "tokenizer_config.json", onFileProgress),
  ]);
  const tokenizer = new WhisperTokenizer(tokenizerJson, tokenizerConfig);
  const feature_extractor = await AutoFeatureExtractor.from_pretrained(model.repo, options);
  const processor = new WhisperProcessor({}, { tokenizer, feature_extractor }, null);
  const whisper = await AutoModelForSpeechSeq2Seq.from_pretrained(model.repo, {
    ...options,
    dtype: model.dtype,
    device,
  });
  return new AutomaticSpeechRecognitionPipeline({ task: ASR_TASK, model: whisper, tokenizer, processor });
}

async function load(id: number, model: AsrModel): Promise<AsrResponse> {
  if (current?.modelId === model.id) return { type: "loaded", id, device: current.device, loadMs: 0 };
  await current?.transcriber.dispose();
  current = null;

  const startedAt = performance.now();
  const total = model.sizeMB * 1024 * 1024;
  const loadedByFile = new Map<string, number>();
  let lastSent = 0;
  let sentLoaded = -1;
  const onFileProgress = (file: string, fileLoaded: number) => {
    loadedByFile.set(file, fileLoaded);
    let sum = 0;
    for (const bytes of loadedByFile.values()) sum += bytes;
    const loaded = Math.min(sum, total);
    const now = performance.now();
    if (loaded === sentLoaded || (now - lastSent < 200 && loaded < total)) return;
    lastSent = now;
    sentLoaded = loaded;
    send({ type: "download", id, loaded, total });
  };

  const devices: AsrDevice[] = (await self.navigator.gpu?.requestAdapter()) ? ["webgpu", "wasm"] : ["wasm"];
  let lastError: unknown;
  for (const device of devices) {
    let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
    try {
      const downloading = (await missingFiles(model)).length > 0;
      transcriber = await loadTranscriber(model, device, downloading ? onFileProgress : undefined);
      // Compile shaders and allocate buffers now so the first real window is not slow.
      await transcriber(new Float32Array(SAMPLE_RATE), { language: ASR_LANGUAGE, task: "transcribe" });
      current = { modelId: model.id, device, transcriber };
      return { type: "loaded", id, device, loadMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      lastError = error;
      console.warn(`ASR load failed on ${device}`, error);
      // A pipeline that loaded but cannot run still holds its sessions.
      try {
        await transcriber?.dispose();
      } catch (disposeError) {
        console.warn(`ASR dispose failed on ${device}`, disposeError);
      }
    }
  }
  throw lastError;
}

async function transcribe(id: number, audio: Float32Array): Promise<AsrResponse> {
  if (!current) throw new Error("Model not loaded");
  const startedAt = performance.now();
  // One call per ≤30 s window, no `chunk_length_s`: the caller splits audio at pauses.
  const output = await current.transcriber(audio, {
    return_timestamps: true,
    language: ASR_LANGUAGE,
    task: "transcribe",
  });
  const chunks: AsrChunk[] = (
    output.chunks ?? [{ text: output.text, timestamp: [0, audio.length / SAMPLE_RATE] }]
  ).map((chunk) => ({ text: chunk.text, start: chunk.timestamp[0], end: chunk.timestamp[1] ?? null }));
  return { type: "transcribed", id, chunks, ms: Math.round(performance.now() - startedAt) };
}

async function loadSegmenter(): Promise<Segmenter> {
  const { repo, revision, dtype } = SPEAKER_SEGMENTATION;
  const processor = (await AutoProcessor.from_pretrained(repo, { revision })) as PyAnnoteProcessor;
  const model = await AutoModelForAudioFrameClassification.from_pretrained(repo, { revision, dtype, device: "wasm" });
  // Labels are NO_SPEAKER, SPEAKER_1, SPEAKERS_1_AND_2: the numbers name the local speakers.
  const { id2label } = model.config as typeof model.config & { id2label: Record<string, string> };
  const classSpeakers: number[][] = [];
  for (const [classId, label] of Object.entries(id2label)) {
    classSpeakers[Number(classId)] = (label.match(/\d+/g) ?? []).map(Number);
  }
  return { model, processor, classSpeakers, minSamples: processor.feature_extractor!.config.offset + 1 };
}

/** Loads the embedding model on the GPU when there is one: it is all convolutions, about ten times faster there than on WASM. */
async function loadEmbedder(): Promise<Embedder> {
  const { repo, revision, dtype } = SPEAKER_EMBEDDING;
  const processor = await AutoProcessor.from_pretrained(repo, { revision });
  const devices: AsrDevice[] = (await self.navigator.gpu?.requestAdapter()) ? ["webgpu", "wasm"] : ["wasm"];
  let lastError: unknown;
  for (const device of devices) {
    let model: PreTrainedModel | null = null;
    try {
      model = await AutoModel.from_pretrained(repo, { revision, dtype, device });
      // A model that loaded can still fail to run on this GPU.
      await model(await processor(new Float32Array(SAMPLE_RATE)));
      return { model, processor };
    } catch (error) {
      lastError = error;
      console.warn(`Speaker embedding model failed on ${device}`, error);
      try {
        await model?.dispose();
      } catch (disposeError) {
        console.warn(`Speaker embedding model dispose failed on ${device}`, disposeError);
      }
    }
  }
  throw lastError;
}

/** Loads each speaker model once. A model that failed to load is tried again on the next call. */
async function loadSpeakerModels(): Promise<{ segmenter: Segmenter; embedder: Embedder }> {
  segmenter ??= await loadSegmenter();
  embedder ??= await loadEmbedder();
  return { segmenter, embedder };
}

/** Who talks when in `audio`, one entry per local speaker in order of first appearance. */
async function segmentSpeakers(segmenter: Segmenter, audio: Float32Array): Promise<LocalSpeaker[]> {
  if (audio.length < segmenter.minSamples) return [];
  const { logits } = await segmenter.model(await segmenter.processor(audio));
  const duration = audio.length / SAMPLE_RATE;
  const locals = new Map<number, LocalSpeaker>();
  for (const segment of segmenter.processor.post_process_speaker_diarization(logits, audio.length)[0]) {
    const speakers = segmenter.classSpeakers[segment.id];
    // The last frame can end after the audio does.
    const end = Math.min(segment.end, duration);
    for (const speaker of speakers) {
      let local = locals.get(speaker);
      if (!local) locals.set(speaker, (local = { turns: [], solo: [], soloSamples: 0 }));
      const last = local.turns.at(-1);
      if (last && segment.start <= last.end) last.end = end;
      else local.turns.push({ start: segment.start, end });
      if (speakers.length === 1) {
        const piece = audio.subarray(Math.round(segment.start * SAMPLE_RATE), Math.round(end * SAMPLE_RATE));
        local.solo.push(piece);
        local.soloSamples += piece.length;
      }
    }
  }
  return [...locals.values()];
}

/** L2-normalised voice embedding of one speaker's audio. */
async function embed(embedder: Embedder, samples: Float32Array): Promise<Float32Array> {
  const { last_hidden_state } = await embedder.model(await embedder.processor(samples));
  const embedding = new Float32Array(last_hidden_state.data as Float32Array);
  let sumOfSquares = 0;
  for (const value of embedding) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;
  return embedding;
}

async function speakers(id: number, audio: Float32Array): Promise<AsrResponse> {
  const { segmenter, embedder } = await loadSpeakerModels();
  const startedAt = performance.now();
  const units: SpeakerUnit[] = [];
  for (const local of await segmentSpeakers(segmenter, audio)) {
    let embedding: Float32Array | null = null;
    if (local.soloSamples >= MIN_EMBEDDING_SAMPLES) {
      const samples = new Float32Array(local.soloSamples);
      let offset = 0;
      for (const piece of local.solo) {
        samples.set(piece, offset);
        offset += piece.length;
      }
      embedding = await embed(embedder, samples);
    }
    units.push({ turns: local.turns, embedding });
  }
  return { type: "speakers", id, units, ms: Math.round(performance.now() - startedAt) };
}

async function handle(request: AsrRequest): Promise<AsrResponse> {
  switch (request.type) {
    case "status":
      return { type: "status", id: request.id, missing: await missingFiles(request.model) };
    case "remove":
      await removeFiles(request.model);
      return { type: "removed", id: request.id };
    case "load":
      return load(request.id, request.model);
    case "transcribe":
      return transcribe(request.id, request.audio);
    case "prepare-speakers":
      await loadSpeakerModels();
      return { type: "speakers-ready", id: request.id };
    case "speakers":
      return speakers(request.id, request.audio);
    case "prune":
      return { type: "pruned", id: request.id, removed: await prune(request.keep) };
  }
}

/** Buffers the receiver takes over instead of copying. */
function transferables(response: AsrResponse): Transferable[] {
  if (response.type !== "speakers") return [];
  return response.units.flatMap((unit) => (unit.embedding ? [unit.embedding.buffer as ArrayBuffer] : []));
}

function send(message: AsrResponse) {
  self.postMessage(message, { transfer: transferables(message) });
}

// One request at a time: the models are not reentrant.
let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<AsrRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      send(await handle(request));
    } catch (error) {
      send({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  });
});
