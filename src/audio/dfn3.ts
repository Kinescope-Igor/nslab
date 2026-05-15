/**
 * DeepFilterNet 3 wrapper через `deepfilter-standalone` (MIT, WASM-runtime).
 *
 * Особенности DFN-3:
 *  - sample rate 48 kHz моно (тот же, что у RNNoise → переиспользуем forwarder)
 *  - frame size берём из getFrameLength() — обычно 480 samples (10 ms)
 *  - WASM и модель грузятся из CDN при первом initialize() (~3 MB)
 *
 * Streaming mode: модель сохраняет внутреннее состояние между вызовами
 * processStreaming() — критично для real-time-monitor, чтобы не было
 * щелчков на границах фреймов.
 */

interface Loaded {
  frameSize: number;
  /** in-place denoise: возвращает Float32Array той же длины (обычно). */
  processFrame: (frame: Float32Array) => Float32Array;
  destroy: () => void;
}

let loadedPromise: Promise<Loaded> | null = null;
let loadedSync: Loaded | null = null;

export async function init(): Promise<Loaded> {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      const { StandaloneDeepFilter } = await import('deepfilter-standalone');
      const denoiser = new StandaloneDeepFilter({
        attenuationLimit: 100, // максимальное подавление шума (default 50, спека до 100)
        postFilterBeta: 0.02,  // лёгкий post-filter
      });
      await denoiser.initialize();
      denoiser.startStreaming();

      const loaded: Loaded = {
        frameSize: denoiser.getFrameLength(),
        processFrame: (frame: Float32Array) => denoiser.processStreaming(frame),
        destroy: () => {
          try {
            denoiser.stopStreaming();
          } finally {
            denoiser.destroy();
          }
        },
      };
      loadedSync = loaded;
      return loaded;
    })().catch((err) => {
      loadedPromise = null;
      throw err;
    });
  }
  return loadedPromise;
}

/**
 * Sync hot-path. Возвращает Float32Array — может быть короче или длиннее
 * входного фрейма (streaming mode копит буфер). Вызывающий должен буферизовать.
 */
export function processFrame(frame: Float32Array): Float32Array {
  if (!loadedSync) throw new Error('dfn3 not initialised — await init() first');
  return loadedSync.processFrame(frame);
}

export async function destroy(): Promise<void> {
  if (loadedPromise) {
    const loaded = await loadedPromise.catch(() => null);
    loaded?.destroy();
    loadedPromise = null;
    loadedSync = null;
  }
}
