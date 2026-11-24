import type { AsrChunk, AsrDevice, AsrRequest, AsrResponse, SpeakerUnit } from "./asr-protocol.ts";
import type { AsrModel } from "./models.ts";

interface Pending {
  resolve: (response: AsrResponse) => void;
  reject: (error: Error) => void;
  onDownload?: (loaded: number, total: number) => void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Promise API over the model worker. The worker runs requests one at a time. */
export class AsrClient {
  #onCrash: () => void;
  #worker: Worker | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();

  /** onCrash runs after the worker died. Pending requests are rejected and the next request starts a new worker with no model loaded. */
  constructor(onCrash: () => void) {
    this.#onCrash = onCrash;
  }

  /** Model files not yet in the browser cache; empty means loading needs no network. */
  async missingFiles(model: AsrModel): Promise<string[]> {
    const response = await this.#request({ type: "status", model });
    if (response.type !== "status") throw new Error(`Unexpected ${response.type} response`);
    return response.missing;
  }

  async remove(model: AsrModel): Promise<void> {
    await this.#request({ type: "remove", model });
  }

  /** Downloads missing files (reporting bytes), then loads and warms the model. */
  async load(
    model: AsrModel,
    onDownload?: (loaded: number, total: number) => void,
  ): Promise<{ device: AsrDevice; loadMs: number }> {
    const response = await this.#request({ type: "load", model }, undefined, onDownload);
    if (response.type !== "loaded") throw new Error(`Unexpected ${response.type} response`);
    return { device: response.device, loadMs: response.loadMs };
  }

  /** Transfers `audio` to the worker; the caller's buffer is detached afterwards. */
  async transcribe(audio: Float32Array): Promise<{ chunks: AsrChunk[]; ms: number }> {
    const response = await this.#request({ type: "transcribe", audio }, [audio.buffer as ArrayBuffer]);
    if (response.type !== "transcribed") throw new Error(`Unexpected ${response.type} response`);
    return { chunks: response.chunks, ms: response.ms };
  }

  /** Downloads and loads the two speaker models. Safe to call again. */
  async prepareSpeakers(): Promise<void> {
    await this.#request({ type: "prepare-speakers" });
  }

  /** Local speakers in at most 10 s of 16 kHz mono audio. Loads the speaker models on first use. Transfers `audio`. */
  async speakers(audio: Float32Array): Promise<SpeakerUnit[]> {
    const response = await this.#request({ type: "speakers", audio }, [audio.buffer as ArrayBuffer]);
    if (response.type !== "speakers") throw new Error(`Unexpected ${response.type} response`);
    return response.units;
  }

  /** Deletes every cached file the app does not need while `keep` is the selected model. Returns how many were deleted. */
  async prune(keep: AsrModel): Promise<number> {
    const response = await this.#request({ type: "prune", keep });
    if (response.type !== "pruned") throw new Error(`Unexpected ${response.type} response`);
    return response.removed;
  }

  #request(
    request: DistributiveOmit<AsrRequest, "id">,
    transfer?: Transferable[],
    onDownload?: Pending["onDownload"],
  ): Promise<AsrResponse> {
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<AsrResponse>();
    this.#pending.set(id, { resolve, reject, onDownload });
    this.#worker ??= this.#startWorker();
    this.#worker.postMessage({ ...request, id } as AsrRequest, transfer ?? []);
    return promise;
  }

  #startWorker(): Worker {
    const worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<AsrResponse>) => {
      const response = event.data;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      if (response.type === "download") {
        pending.onDownload?.(response.loaded, response.total);
        return;
      }
      this.#pending.delete(response.id);
      if (response.type === "error") pending.reject(new Error(response.message));
      else pending.resolve(response);
    });
    const crash = (detail: string) => {
      // A dying worker can report more than one event.
      if (this.#worker !== worker) return;
      const error = new Error(`The speech model crashed: ${detail}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      worker.terminate();
      this.#worker = null;
      this.#onCrash();
    };
    worker.addEventListener("error", (event) => crash(event.message || "unknown error"));
    worker.addEventListener("messageerror", () => crash("unreadable message"));
    return worker;
  }
}
