/**
 * RNNoise wrapper. Lazy-init: модель грузится один раз при первом setMode('rnnoise').
 * Через dynamic import() — чтобы WASM (~3 MB) не попадал в основной bundle.
 *
 * Особенности RNNoise:
 *  - sample rate 48 kHz (в браузере по дефолту так и есть)
 *  - frame size 480 samples (10 ms)
 *  - входные семплы должны быть 16-bit PCM, scaled to Float32 (умножить на 32768)
 *  - возвращает VAD-вероятность [0..1]
 */

let denoiseStatePromise: Promise<{
  processFrame: (frame: Float32Array) => number;
  destroy: () => void;
}> | null = null;

export const FRAME_SIZE = 480;

export async function init(): Promise<void> {
  if (!denoiseStatePromise) {
    denoiseStatePromise = (async () => {
      const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
      const rnnoise = await Rnnoise.load();
      const state = rnnoise.createDenoiseState();
      return {
        processFrame: (frame: Float32Array) => state.processFrame(frame),
        destroy: () => state.destroy(),
      };
    })();
  }
  await denoiseStatePromise;
}

/** Обрабатывает фрейм in-place. Возвращает VAD [0..1]. */
export async function processFrame(frame: Float32Array): Promise<number> {
  if (!denoiseStatePromise) throw new Error('rnnoise not initialised');
  const state = await denoiseStatePromise;
  // Scale [-1, 1] → [-32768, 32767] (RNNoise ожидает 16-bit PCM в Float32).
  for (let i = 0; i < frame.length; i++) frame[i] *= 32768;
  const vad = state.processFrame(frame);
  // Обратно в [-1, 1].
  for (let i = 0; i < frame.length; i++) frame[i] /= 32768;
  return vad;
}

export async function destroy(): Promise<void> {
  if (denoiseStatePromise) {
    const state = await denoiseStatePromise;
    state.destroy();
    denoiseStatePromise = null;
  }
}
