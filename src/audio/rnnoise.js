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
let loadedPromise = null;
let loadedSync = null; // hot-path кэш после init
export async function init() {
    if (!loadedPromise) {
        loadedPromise = (async () => {
            const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
            const rnnoise = await Rnnoise.load();
            const state = rnnoise.createDenoiseState();
            const loaded = {
                frameSize: rnnoise.frameSize,
                processFrame: (frame) => state.processFrame(frame),
                destroy: () => state.destroy(),
            };
            loadedSync = loaded;
            return loaded;
        })().catch((err) => {
            // Сбрасываем кэш, иначе следующий init() мгновенно вернёт rejected
            // promise без попытки реинициализации (404 / network blip → permanent fail).
            loadedPromise = null;
            throw err;
        });
    }
    return loadedPromise;
}
/**
 * Обрабатывает фрейм in-place. Возвращает VAD [0..1].
 * Sync hot-path — без лишнего await на 100/сек вызовов после init.
 * Если init ещё не завершился, бросает (вызывающий должен сначала await init()).
 */
export function processFrame(frame) {
    if (!loadedSync)
        throw new Error('rnnoise not initialised — await init() first');
    // Scale [-1, 1] → [-32768, 32767] (RNNoise ожидает 16-bit PCM в Float32).
    for (let i = 0; i < frame.length; i++)
        frame[i] *= 32768;
    const vad = loadedSync.processFrame(frame);
    // Обратно в [-1, 1].
    for (let i = 0; i < frame.length; i++)
        frame[i] /= 32768;
    return vad;
}
export async function destroy() {
    if (loadedPromise) {
        const loaded = await loadedPromise.catch(() => null);
        loaded?.destroy();
        loadedPromise = null;
        loadedSync = null;
    }
}
