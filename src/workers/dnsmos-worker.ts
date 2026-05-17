/**
 * DNSMOS inference в Web Worker — main thread не блокируется на ONNX run,
 * RAF/AudioWorklet port-queue остаются плавными.
 *
 * Worker принимает audio Float32Array @ 16 kHz mono, возвращает {sig, bak, ovr}.
 * Init lazy при первом score-сообщении.
 */

import * as ort from 'onnxruntime-web';

const TARGET_SR = 16000;
const INPUT_LENGTH_SEC = 9.01;
const INPUT_SAMPLES = Math.round(INPUT_LENGTH_SEC * TARGET_SR);

const polyEval = (coeffs: number[], x: number) =>
  coeffs.reduce((acc, c) => acc * x + c, 0);
const COEFFS_SIG = [-0.08397278, 1.22083953, 0.0052439];
const COEFFS_BAK = [-0.13166888, 1.60915514, -0.39604546];
const COEFFS_OVR = [-0.06766283, 1.11546468, 0.04602535];

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(modelUrl: string): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // non-JSEP build (13 MB) вместо default JSEP (26 MB). iOS Safari ловит
      // OOM при компиляции JSEP-варианта на iPhone. DNSMOS-у webgpu не нужен.
      const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
      (ort.env.wasm as unknown as { wasmPaths: Record<string, string> }).wasmPaths = {
        'ort-wasm-simd-threaded.wasm': `${base}ort-wasm-simd-threaded.wasm`,
        'ort-wasm-simd-threaded.mjs': `${base}ort-wasm-simd-threaded.mjs`,
      };
      return ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      });
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

interface ScoreRequest {
  type: 'score';
  id: number;
  samples: Float32Array;
  sourceSampleRate: number;
  modelUrl: string;
}

/**
 * Простой anti-alias-decimate downsample: усреднение полу-окном.
 * Для DNSMOS approximation достаточно — потеря MOS-точности минимальная,
 * выигрыш в том, что resample делается в worker (а не через
 * OfflineAudioContext в main thread, что вызывало spike-блокировку).
 */
function downsample(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outputLen = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLen);
  for (let i = 0; i < outputLen; i++) {
    const srcStart = Math.floor(i * ratio);
    const srcEnd = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = srcStart; j < srcEnd; j++) {
      sum += input[j];
      count++;
    }
    output[i] = count > 0 ? sum / count : 0;
  }
  return output;
}

self.onmessage = async (e: MessageEvent<ScoreRequest>) => {
  const msg = e.data;
  if (msg.type !== 'score') return;

  try {
    const session = await getSession(msg.modelUrl);

    // Resample внутри worker (раньше делалось через OfflineAudioContext в main,
    // что давало регулярные блокировки → прерывистый output).
    let audio = downsample(msg.samples, msg.sourceSampleRate, TARGET_SR);

    while (audio.length < INPUT_SAMPLES) {
      const merged = new Float32Array(audio.length * 2);
      merged.set(audio, 0);
      merged.set(audio, audio.length);
      audio = merged;
    }
    const seg = audio.subarray(audio.length - INPUT_SAMPLES, audio.length);

    const tensor = new ort.Tensor('float32', seg, [1, seg.length]);
    const out = await session.run({ input_1: tensor });
    const result = out[Object.keys(out)[0]];
    const data = result.data as Float32Array;

    self.postMessage({
      type: 'score-result',
      id: msg.id,
      sig: polyEval(COEFFS_SIG, data[0]),
      bak: polyEval(COEFFS_BAK, data[1]),
      ovr: polyEval(COEFFS_OVR, data[2]),
    });
  } catch (err) {
    self.postMessage({
      type: 'score-error',
      id: msg.id,
      error: (err as Error).message,
    });
  }
};
