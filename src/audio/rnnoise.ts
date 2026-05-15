/**
 * RNNoise wrapper. Lazy-init: модель грузится один раз при первом setMode('rnnoise').
 * Через dynamic import() — чтобы WASM (~3 MB) не попадал в основной bundle.
 *
 * Особенности RNNoise:
 *  - sample rate 48 kHz (в браузере по дефолту так и есть)
 *  - frame size 480 samples (10 ms) — берём из runtime, не хардкодим
 *  - входные семплы должны быть 16-bit PCM, scaled to Float32 (умножить на 32768)
 *  - возвращает VAD-вероятность [0..1]
 */

interface Loaded {
  frameSize: number;
  processFrame: (frame: Float32Array) => number;
  destroy: () => void;
}

let loadedPromise: Promise<Loaded> | null = null;

export async function init(): Promise<Loaded> {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
      const rnnoise = await Rnnoise.load();
      const state = rnnoise.createDenoiseState();
      return {
        frameSize: rnnoise.frameSize,
        processFrame: (frame: Float32Array) => state.processFrame(frame),
        destroy: () => state.destroy(),
      };
    })().catch((err) => {
      // Сбрасываем кэш, иначе следующий init() мгновенно вернёт rejected
      // promise без попытки реинициализации (404 / network blip → permanent fail).
      loadedPromise = null;
      throw err;
    });
  }
  return loadedPromise;
}

/** Обрабатывает фрейм in-place. Возвращает VAD [0..1]. */
export async function processFrame(frame: Float32Array): Promise<number> {
  const loaded = await init();
  // Scale [-1, 1] → [-32768, 32767] (RNNoise ожидает 16-bit PCM в Float32).
  for (let i = 0; i < frame.length; i++) frame[i] *= 32768;
  const vad = loaded.processFrame(frame);
  // Обратно в [-1, 1].
  for (let i = 0; i < frame.length; i++) frame[i] /= 32768;
  return vad;
}

export async function destroy(): Promise<void> {
  if (loadedPromise) {
    const loaded = await loadedPromise;
    loaded.destroy();
    loadedPromise = null;
  }
}
