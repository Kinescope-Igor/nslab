/**
 * DeepFilterNet 3 wrapper над **самостоятельно собранным WASM** из
 * Rikorose/DeepFilterNet (commit main, май 2026, см. dfn3_build_report.md).
 *
 * Раньше использовали npm-пакет `deepfilter-standalone`, но его JS-glue и
 * WASM на стороннем CDN были разных версий → df_create() бросал
 * RuntimeError: unreachable. Сборка из сорсов гарантирует точное
 * соответствие.
 *
 * Ассеты в public/dfn3-self/:
 *  - df.js          — wasm-bindgen JS-glue (no-modules target → IIFE)
 *  - df_bg.wasm     — наша сборка через `wasm-pack build libDF --target no-modules --features wasm`
 *  - DeepFilterNet3_onnx.bin — pretrained веса из models/ репо автора.
 *    Это РОВНО тот же gzipped tar, что у Rikorose, переименованный из
 *    .tar.gz в .bin чтобы Vite/sirv не отдавал `Content-Encoding: gzip`
 *    (браузер тогда сам распаковывает body → GzDecoder в Rust ругается
 *    «invalid gzip header»).
 *
 * API (из df.d.ts):
 *  - wasm_bindgen(wasmUrl)                                    — init
 *  - wasm_bindgen.df_create(modelBytes: Uint8Array, atten_lim: number): number   — handle
 *  - wasm_bindgen.df_get_frame_length(handle): number         — обычно 480
 *  - wasm_bindgen.df_set_post_filter_beta(handle, beta): void
 *  - wasm_bindgen.df_process_frame(handle, frame: Float32Array): Float32Array
 *
 * Параметры аудио: 48 kHz моно, frame = hop = 480 samples (10 ms).
 */
const DF_JS_URL = new URL('dfn3-self/df.js', document.baseURI).href;
const DF_WASM_URL = new URL('dfn3-self/df_bg.wasm', document.baseURI).href;
const DF_MODEL_URL = new URL('dfn3-self/DeepFilterNet3_onnx.bin', document.baseURI).href;
let bindings = null;
let loadedPromise = null;
let loadedSync = null;
async function loadDfJs() {
    if (bindings)
        return bindings;
    await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${DF_JS_URL}"]`);
        if (existing) {
            // df.js уже вставлен (повторный init после destroy) — global wasm_bindgen жив.
            resolve();
            return;
        }
        const s = document.createElement('script');
        s.src = DF_JS_URL;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`failed to load ${DF_JS_URL}`));
        document.head.appendChild(s);
    });
    const wb = globalThis.wasm_bindgen;
    if (!wb)
        throw new Error('wasm_bindgen global not exported by df.js');
    bindings = wb;
    return wb;
}
export async function init() {
    if (!loadedPromise) {
        loadedPromise = (async () => {
            const wb = await loadDfJs();
            await wb(DF_WASM_URL);
            const modelBytes = new Uint8Array(await (await fetch(DF_MODEL_URL)).arrayBuffer());
            // attenuation_limit в dB: 100 = максимальное подавление (default по df-CLI).
            // С нашим WASM это безопасно (в отличие от чужого CDN, где падало).
            const handle = wb.df_create(modelBytes, 100);
            if (!handle)
                throw new Error('df_create returned null');
            wb.df_set_post_filter_beta(handle, 0.02);
            const frameSize = wb.df_get_frame_length(handle);
            const loaded = {
                frameSize,
                processFrame: (frame) => wb.df_process_frame(handle, frame),
                destroy: () => {
                    // В нашем API нет df_destroy; handle живёт до perdoy унифицирующего unload.
                    // Для бенчмарка ОК — memory освободится при reload страницы.
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
/** Sync hot-path после init: in-place denoise одного фрейма. */
export function processFrame(frame) {
    if (!loadedSync)
        throw new Error('dfn3 not initialised — await init() first');
    return loadedSync.processFrame(frame);
}
export async function destroy() {
    if (loadedPromise) {
        const loaded = await loadedPromise.catch(() => null);
        loaded?.destroy();
        loadedPromise = null;
        loadedSync = null;
    }
}
