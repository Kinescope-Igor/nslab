/**
 * ZipEnhancer wrapper над Web Worker (см. src/workers/zipenhancer-worker.ts).
 * Main thread не блокируется на тяжёлой ONNX inference (~200-500 ms на chunk).
 *
 * Архитектура: ZipFormer (Alibaba, Apache 2.0), 2M params, PESQ 3.69 на DNS2020.
 * End-to-end ONNX от DakeQQ (STFT/iSTFT встроены): input/output int16,
 * фиксированный chunk 16000 samples = 1 sec @ 16 kHz.
 */

import ZipEnhancerWorker from '../workers/zipenhancer-worker.ts?worker';

const MODEL_URL = '/zipenhancer/ZipEnhancer.onnx';
const CHUNK_SAMPLES = 16000;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (s: Float32Array) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new ZipEnhancerWorker();
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'process-result') {
      p.resolve(msg.samples);
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

export interface Loaded {
  frameSize: number;
}

export async function init(): Promise<Loaded> {
  ensureWorker();
  return { frameSize: CHUNK_SAMPLES };
}

export function processChunkAsync(frame: Float32Array): Promise<Float32Array> {
  if (frame.length !== CHUNK_SAMPLES) {
    throw new Error(`zipenhancer: ожидаем ${CHUNK_SAMPLES} samples/frame, пришло ${frame.length}`);
  }
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<Float32Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(
      { type: 'process', id, samples: frame, modelUrl: MODEL_URL },
      [frame.buffer],
    );
  });
}

export async function destroy(): Promise<void> {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error('terminated'));
  pending.clear();
}
