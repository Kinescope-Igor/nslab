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
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
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
  modelUrl: string;
}

self.onmessage = async (e: MessageEvent<ScoreRequest>) => {
  const msg = e.data;
  if (msg.type !== 'score') return;

  try {
    const session = await getSession(msg.modelUrl);

    let audio = msg.samples;
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
