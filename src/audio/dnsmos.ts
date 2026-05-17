/**
 * DNSMOS P.835 — client-side обёртка над Web Worker.
 * Сам ONNX inference выполняется в src/workers/dnsmos-worker.ts, чтобы main
 * thread не блокировался (иначе RAF/AudioWorklet начинают захлёбываться).
 */

import DnsmosWorker from '../workers/dnsmos-worker.ts?worker';

export const TARGET_SR = 16000;
// Absolute URL от текущей страницы (под dev будет /dnsmos/...,
// под /lab/noise-bench/ → /lab/noise-bench/dnsmos/...). Worker
// получит готовый absolute, его fetch будет работать корректно
// (без этого worker fetch'ил бы относительно /lab/noise-bench/assets/).
const MODEL_URL = new URL('dnsmos/sig_bak_ovr.onnx', document.baseURI).href;

export interface MosScore {
  sig: number;
  bak: number;
  ovr: number;
  segments: number;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (s: MosScore) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new DnsmosWorker();
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'score-result') {
      p.resolve({ sig: msg.sig, bak: msg.bak, ovr: msg.ovr, segments: 1 });
    } else {
      p.reject(new Error(msg.error ?? 'unknown'));
    }
  };
  worker.onerror = (err) => {
    for (const p of pending.values()) p.reject(new Error(err.message));
    pending.clear();
  };
  return worker;
}

export async function init(): Promise<void> {
  ensureWorker();
}

/**
 * Считает MOS на буфере произвольного sample rate.
 * Resample 48→16 (или любой другой) делается ВНУТРИ worker'а, чтобы main
 * thread не блокировался → forwarder port-queue от RNNoise/DFN не накапливает
 * burst → output плавный.
 */
export function score(samples: Float32Array, sourceSampleRate: number): Promise<MosScore> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<MosScore>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(
      { type: 'score', id, samples, sourceSampleRate, modelUrl: MODEL_URL },
      [samples.buffer],
    );
  });
}

export function destroy(): void {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error('terminated'));
  pending.clear();
}
