/**
 * DNSMOS P.835 inference через onnxruntime-web.
 *
 * Источник: github.com/microsoft/DNS-Challenge (MIT). Модель sig_bak_ovr.onnx
 * лежит в public/dnsmos/, скачивается postinstall'ом.
 *
 * Pipeline (по dnsmos_local.py):
 *  1. вход 16 kHz моно, 9.01 секунды (= 144 160 samples)
 *  2. ONNX inference → [sig_raw, bak_raw, ovr_raw]
 *  3. polyfit-калибровка → SIG / BAK / OVRL по шкале 1-5
 *
 * Если входной фрейм длиннее 9 sec — режется на окна с шагом 1 sec, scores усредняются.
 */

import * as ort from 'onnxruntime-web';

export const TARGET_SR = 16000;
const INPUT_LENGTH_SEC = 9.01;
const INPUT_SAMPLES = Math.round(INPUT_LENGTH_SEC * TARGET_SR);

// Polyfit для non-personalized MOS (см. dnsmos_local.py).
const polyEval = (coeffs: number[], x: number) =>
  coeffs.reduce((acc, c) => acc * x + c, 0);
const COEFFS_SIG = [-0.08397278, 1.22083953, 0.0052439];
const COEFFS_BAK = [-0.13166888, 1.60915514, -0.39604546];
const COEFFS_OVR = [-0.06766283, 1.11546468, 0.04602535];

export interface MosScore {
  sig: number;
  bak: number;
  ovr: number;
  segments: number; // сколько 9-sec окон усреднено
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

export async function init(): Promise<void> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // WASM artefacts (ort-wasm-*.wasm) лежат в node_modules/onnxruntime-web/dist;
      // Vite их сам не возьмёт — скажем ORT тянуть с jsdelivr.
      // Альтернатива в проде: положить в public/ort-wasm/ через postinstall.
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
      const session = await ort.InferenceSession.create('/dnsmos/sig_bak_ovr.onnx', {
        executionProviders: ['wasm'],
      });
      return session;
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  await sessionPromise;
}

/** Считает MOS на буфере 16 kHz моно. Если буфер короче 9 sec — повторяет. */
export async function score(audio16k: Float32Array): Promise<MosScore> {
  if (!sessionPromise) throw new Error('dnsmos not initialised');
  const session = await sessionPromise;

  // Pad повторами, если короче нужного окна (как в reference Python).
  let audio = audio16k;
  while (audio.length < INPUT_SAMPLES) {
    const merged = new Float32Array(audio.length * 2);
    merged.set(audio, 0);
    merged.set(audio, audio.length);
    audio = merged;
  }

  // Скользящее окно с шагом 1 sec.
  const hopSamples = TARGET_SR;
  const numHops = Math.max(1, Math.floor(audio.length / TARGET_SR) - INPUT_LENGTH_SEC + 1);

  let sumSig = 0, sumBak = 0, sumOvr = 0, count = 0;

  for (let i = 0; i < numHops; i++) {
    const start = Math.floor(i * hopSamples);
    const end = start + INPUT_SAMPLES;
    if (end > audio.length) break;
    const seg = audio.subarray(start, end);

    const tensor = new ort.Tensor('float32', seg, [1, seg.length]);
    const out = await session.run({ input_1: tensor });
    const result = out[Object.keys(out)[0]];
    const data = result.data as Float32Array;
    // ONNX output: [1, 3] → [sig_raw, bak_raw, ovr_raw]
    sumSig += polyEval(COEFFS_SIG, data[0]);
    sumBak += polyEval(COEFFS_BAK, data[1]);
    sumOvr += polyEval(COEFFS_OVR, data[2]);
    count++;
  }

  return {
    sig: sumSig / count,
    bak: sumBak / count,
    ovr: sumOvr / count,
    segments: count,
  };
}
