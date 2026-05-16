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

/**
 * Считает MOS на ОДНОМ последнем 9-sec окне буфера 16 kHz моно.
 *
 * Ранее усредняли по всем окнам (как dnsmos_local.py для batch-оценки файла),
 * но в real-time это блокировало main thread на 200-800 ms каждые 3 sec и
 * убивало spectrogram. Single window даёт ту же точность (DNSMOS не сильно
 * варьируется внутри 12 sec речи) при 1 inference вместо 3-4.
 *
 * Если буфер короче 9 sec — повторяет до достижения нужной длины.
 */
export async function score(audio16k: Float32Array): Promise<MosScore> {
  if (!sessionPromise) throw new Error('dnsmos not initialised');
  const session = await sessionPromise;

  let audio = audio16k;
  while (audio.length < INPUT_SAMPLES) {
    const merged = new Float32Array(audio.length * 2);
    merged.set(audio, 0);
    merged.set(audio, audio.length);
    audio = merged;
  }

  // Берём ровно последние 9.01 sec.
  const seg = audio.subarray(audio.length - INPUT_SAMPLES, audio.length);

  const tensor = new ort.Tensor('float32', seg, [1, seg.length]);
  const out = await session.run({ input_1: tensor });
  const result = out[Object.keys(out)[0]];
  const data = result.data as Float32Array;

  return {
    sig: polyEval(COEFFS_SIG, data[0]),
    bak: polyEval(COEFFS_BAK, data[1]),
    ovr: polyEval(COEFFS_OVR, data[2]),
    segments: 1,
  };
}
