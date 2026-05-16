/**
 * DNSMOS P.835 — client-side обёртка над Web Worker.
 * Сам ONNX inference выполняется в src/workers/dnsmos-worker.ts, чтобы main
 * thread не блокировался (иначе RAF/AudioWorklet начинают захлёбываться).
 */

import DnsmosWorker from '../workers/dnsmos-worker.ts?worker';

export const TARGET_SR = 16000;
const MODEL_URL = '/dnsmos/sig_bak_ovr.onnx';

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

export function score(audio16k: Float32Array): Promise<MosScore> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<MosScore>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Transfer ownership — без копии больших Float32Array через границу worker'а.
    w.postMessage({ type: 'score', id, samples: audio16k, modelUrl: MODEL_URL }, [audio16k.buffer]);
  });
}

export function destroy(): void {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error('terminated'));
  pending.clear();
}
