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

interface DfBindings {
  (wasmUrl: string): Promise<unknown>;
  df_create: (modelBytes: Uint8Array, attenLim: number) => number;
  df_get_frame_length: (handle: number) => number;
  df_set_post_filter_beta: (handle: number, beta: number) => void;
  df_set_atten_lim: (handle: number, lim: number) => void;
  df_process_frame: (handle: number, frame: Float32Array) => Float32Array;
}

interface Loaded {
  frameSize: number;
  processFrame: (frame: Float32Array) => Float32Array;
  destroy: () => void;
}

let bindings: DfBindings | null = null;
let loadedPromise: Promise<Loaded> | null = null;
let loadedSync: Loaded | null = null;

// Default attenuation_limit в dB — 30 близко к production-настройкам
// типа Krisp. df-CLI default = 100 (max) даёт «вырезы» речи на границах VAD.
export const DEFAULT_ATTEN_LIM_DB = 30;

// Cached refs для setAttenLim/setPostFilterBeta без re-init.
let bindingsRef: DfBindings | null = null;
let handleRef: number | null = null;

async function loadDfJs(): Promise<DfBindings> {
  if (bindings) return bindings;
  await new Promise<void>((resolve, reject) => {
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
  const wb = (globalThis as { wasm_bindgen?: DfBindings }).wasm_bindgen;
  if (!wb) throw new Error('wasm_bindgen global not exported by df.js');
  bindings = wb;
  return wb;
}

export async function init(): Promise<Loaded> {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      const wb = await loadDfJs();
      await wb(DF_WASM_URL);

      const modelBytes = new Uint8Array(await (await fetch(DF_MODEL_URL)).arrayBuffer());
      // attenuation_limit в dB: max сколько модель имеет права срезать.
      // df-CLI default = 100 dB ≈ почти полное замолкание не-речи, но при
      // этом могут вырезаться сегменты речи на границах VAD → «прерывания».
      // 30 dB — типичный production-default (как Krisp/Discord) — звучит
      // естественно, сохраняет «дыхание» между фразами.
      const handle = wb.df_create(modelBytes, DEFAULT_ATTEN_LIM_DB);
      if (!handle) throw new Error('df_create returned null');
      // post-filter beta = 0 выключает доп. подавление; 0.02-0.05 — мягко.
      // Для DFN-3 с atten_lim=30 пока оставляем выключенным.
      wb.df_set_post_filter_beta(handle, 0);

      handleRef = handle;
      bindingsRef = wb;

      const frameSize = wb.df_get_frame_length(handle);

      const loaded: Loaded = {
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

/** Поменять attenuation_limit (dB) без re-init. 30 — типичное, 100 — max. */
export function setAttenLim(db: number): void {
  if (bindingsRef && handleRef != null) bindingsRef.df_set_atten_lim(handleRef, db);
}

/** Post-filter beta. 0 = выкл, 0.02-0.05 = мягко, 0.1+ = агрессивно. */
export function setPostFilterBeta(beta: number): void {
  if (bindingsRef && handleRef != null) bindingsRef.df_set_post_filter_beta(handleRef, beta);
}

/** Sync hot-path после init: in-place denoise одного фрейма. */
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
    bindingsRef = null;
    handleRef = null;
  }
}
