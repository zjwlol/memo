import { SAMPLE_RATE } from "./store.ts";

const MB = 1024 * 1024;

/** True when this browser has every API that recording and storing audio needs. */
export function canRecord(): boolean {
  return (
    isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof indexedDB !== "undefined" &&
    typeof caches !== "undefined"
  );
}

/** Only desktop Chrome and Edge share tab or system audio. */
export function canShareAudio(): boolean {
  const agent = navigator.userAgent;
  return (
    /(?:Chrome|Edg)\//.test(agent) && !/Android|Mobile/.test(agent) && "getDisplayMedia" in (navigator.mediaDevices ?? {})
  );
}

export interface GpuInfo {
  available: boolean;
  /** The GPU has the `shader-f16` feature that the largest model needs. */
  f16: boolean;
}

export async function checkGpu(): Promise<GpuInfo> {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  return { available: Boolean(adapter), f16: adapter?.features.has("shader-f16") ?? false };
}

/** Asks for persistent storage so the browser keeps the model, then tells whether `requiredMB` is free. */
export async function hasStorageFor(requiredMB: number): Promise<boolean> {
  if (!(await navigator.storage.persisted())) await navigator.storage.persist();
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  return (quota - usage) / MB >= requiredMB;
}

/** Storage one hour of recording takes (two 16-bit tracks). */
export const MB_PER_RECORDED_HOUR = Math.ceil((SAMPLE_RATE * 2 * 2 * 3600) / MB);
