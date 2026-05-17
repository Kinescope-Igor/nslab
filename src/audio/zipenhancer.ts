/**
 * ZipEnhancer (Alibaba speech_zipenhancer_ans_multiloss_16k_base, Apache 2.0).
 * Архитектура: ZipFormer (Dual-Path Down-Up Sampling-based) + magnitude/phase
 * decoders. SOTA на DNS2020 (PESQ 3.69). ~2M params.
 *
 * Используем end-to-end ONNX от DakeQQ (STFT/iSTFT встроены в граф):
 *   input:  noisy_audio    int16 (1, 1, 16000)  — 1 sec @ 16 kHz
 *   output: denoised_audio int16 (1, 1, ~16000)
 *
 * Внутри: RMS-norm → STFT(n_fft=512, win=400, hop=100, hamming) → magnitude^0.3
 * + phase → ZipEnhancer → mag^(1/0.3) → iSTFT → denorm.
 *
 * Стратегия в браузере: chunk-based, 16000 samples в буфер → одна inference
 * call → 16000 samples enhanced на выход. Latency ~1 sec (компромисс ради
 * качества). Для real-time mic это многовато, но для бенчмарка приемлемо.
 */

import * as ort from 'onnxruntime-web';

const ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
const MODEL_URL = '/zipenhancer/ZipEnhancer.onnx';
const CHUNK_SAMPLES = 16000; // 1 sec @ 16 kHz, фиксированный input shape модели

interface State {
  session: ort.InferenceSession;
  inBuf: Float32Array;    // накопитель входа (CHUNK_SAMPLES)
  inPos: number;
  outQueue: Float32Array; // готовый enhanced поток для отдачи
  outPos: number;
  inflight: Promise<void> | null;
}

let loadedPromise: Promise<State> | null = null;

export interface Loaded {
  frameSize: number; // = CHUNK_SAMPLES; pipeline шлёт фреймы такой длины
}

export async function init(): Promise<Loaded> {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      ort.env.wasm.wasmPaths = ORT_WASM_BASE;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;

      const buf = new Uint8Array(await (await fetch(MODEL_URL)).arrayBuffer());
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      return {
        session,
        inBuf: new Float32Array(CHUNK_SAMPLES),
        inPos: 0,
        outQueue: new Float32Array(0),
        outPos: 0,
        inflight: null,
      };
    })().catch((err) => {
      loadedPromise = null;
      throw err;
    });
  }
  await loadedPromise;
  return { frameSize: CHUNK_SAMPLES };
}

/**
 * Принимает chunk samples (любой длины, но pipeline шлёт frameSize=CHUNK_SAMPLES),
 * возвращает enhanced chunk той же длины. Если буфер ещё не накоплен —
 * возвращает silence; если inference занимает дольше, чем 1 sec — следующий
 * chunk будет silence (drop), но это маловероятно (модель ~3 sec на 6 sec
 * аудио = RTF 0.5, для chunk'а 1 sec ≈ 0.5 sec, укладываемся).
 */
export async function processChunkAsync(frame: Float32Array): Promise<Float32Array> {
  if (!loadedPromise) throw new Error('zipenhancer not initialised');
  const st = await loadedPromise;
  if (frame.length !== CHUNK_SAMPLES) {
    throw new Error(`zipenhancer: ожидаем ${CHUNK_SAMPLES} samples/frame, пришло ${frame.length}`);
  }

  // Конвертируем float32 [-1, 1] → int16 [-32768, 32767].
  const i16 = new Int16Array(CHUNK_SAMPLES);
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    const v = Math.max(-1, Math.min(1, frame[i]));
    i16[i] = Math.round(v * 32767);
  }
  const input = new ort.Tensor('int16', i16, [1, 1, CHUNK_SAMPLES]);

  const outputs = await st.session.run({ noisy_audio: input });
  const denData = outputs.denoised_audio.data as Int16Array;
  const outLen = denData.length;
  const out = new Float32Array(CHUNK_SAMPLES);
  // Берём первые CHUNK_SAMPLES (если модель вернула больше из-за STFT padding).
  const n = Math.min(outLen, CHUNK_SAMPLES);
  for (let i = 0; i < n; i++) out[i] = denData[i] / 32768;
  return out;
}

export async function destroy(): Promise<void> {
  if (loadedPromise) {
    const st = await loadedPromise.catch(() => null);
    await st?.session?.release().catch(() => {});
    loadedPromise = null;
  }
}
