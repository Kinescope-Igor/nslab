/**
 * ZipEnhancer inference в Web Worker — main thread не блокируется на тяжёлой
 * ONNX run (модель 11 MB, ~200-500 ms на chunk в WASM).
 *
 * Worker принимает Float32Array (16000 samples @ 16 kHz mono),
 * возвращает Float32Array (enhanced 16000 samples) через transferable.
 *
 * Init lazy при первом process-сообщении.
 */

import * as ort from 'onnxruntime-web';

const CHUNK_SAMPLES = 16000;
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(modelUrl: string): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort.env.wasm.wasmPaths = ORT_WASM_BASE;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      return ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

interface ProcessRequest {
  type: 'process';
  id: number;
  samples: Float32Array;
  modelUrl: string;
}

self.onmessage = async (e: MessageEvent<ProcessRequest>) => {
  const msg = e.data;
  if (msg.type !== 'process') return;
  try {
    const session = await getSession(msg.modelUrl);
    const samples = msg.samples;
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`zipenhancer-worker: ожидаем ${CHUNK_SAMPLES} samples, пришло ${samples.length}`);
    }
    // float32 [-1, 1] → int16 [-32768, 32767]
    const i16 = new Int16Array(CHUNK_SAMPLES);
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      i16[i] = Math.round(v * 32767);
    }
    const input = new ort.Tensor('int16', i16, [1, 1, CHUNK_SAMPLES]);
    const outputs = await session.run({ noisy_audio: input });
    const den = outputs.denoised_audio.data as Int16Array;
    const out = new Float32Array(CHUNK_SAMPLES);
    const n = Math.min(den.length, CHUNK_SAMPLES);
    for (let i = 0; i < n; i++) out[i] = den[i] / 32768;
    (self as unknown as Worker).postMessage(
      { type: 'process-result', id: msg.id, samples: out },
      [out.buffer],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'process-error',
      id: msg.id,
      error: (err as Error).message,
    });
  }
};
