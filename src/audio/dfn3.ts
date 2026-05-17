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

// Две модели от Rikorose/DeepFilterNet:
//   base — 7.6 MB, 30 ms latency, 2-frame lookahead — лучшее качество
//   ll   — 35 MB,  10 ms latency, 0-frame lookahead — true streaming, для live mic
const MODEL_URLS: Record<Variant, string> = {
  base: new URL('dfn3-self/DeepFilterNet3_onnx.bin', document.baseURI).href,
  ll:   new URL('dfn3-self/DeepFilterNet3_ll.bin', document.baseURI).href,
};

export type Variant = 'base' | 'll';

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

// Default attenuation_limit в dB — 30 близко к production-настройкам
// типа Krisp. df-CLI default = 100 (max) даёт «вырезы» речи на границах VAD.
export const DEFAULT_ATTEN_LIM_DB = 30;

// Per-variant state: каждая модель имеет свой handle + bindings ref.
interface VariantState {
  loadedPromise: Promise<Loaded> | null;
  loadedSync: Loaded | null;
  handleRef: number | null;
}
const states: Record<Variant, VariantState> = {
  base: { loadedPromise: null, loadedSync: null, handleRef: null },
  ll:   { loadedPromise: null, loadedSync: null, handleRef: null },
};

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

export async function init(variant: Variant = 'base'): Promise<Loaded> {
  const st = states[variant];
  if (!st.loadedPromise) {
    st.loadedPromise = (async () => {
      const wb = await loadDfJs();
      await wb(DF_WASM_URL);

      const modelBytes = new Uint8Array(await (await fetch(MODEL_URLS[variant])).arrayBuffer());
      const handle = wb.df_create(modelBytes, DEFAULT_ATTEN_LIM_DB);
      if (!handle) throw new Error(`df_create returned null (variant=${variant})`);
      wb.df_set_post_filter_beta(handle, 0);

      st.handleRef = handle;

      const frameSize = wb.df_get_frame_length(handle);
      const loaded: Loaded = {
        frameSize,
        processFrame: (frame) => wb.df_process_frame(handle, frame),
        destroy: () => {
          // Нет df_destroy в нашем API; handle живёт до reload страницы.
        },
      };
      st.loadedSync = loaded;
      return loaded;
    })().catch((err) => {
      st.loadedPromise = null;
      throw err;
    });
  }
  return st.loadedPromise;
}

/** Поменять attenuation_limit (dB) без re-init. Применяется к указанному variant. */
export function setAttenLim(db: number, variant: Variant = 'base'): void {
  const st = states[variant];
  if (bindings && st.handleRef != null) bindings.df_set_atten_lim(st.handleRef, db);
}

/** Post-filter beta. 0 = выкл, 0.02-0.05 = мягко, 0.1+ = агрессивно. */
export function setPostFilterBeta(beta: number, variant: Variant = 'base'): void {
  const st = states[variant];
  if (bindings && st.handleRef != null) bindings.df_set_post_filter_beta(st.handleRef, beta);
}

/** Sync hot-path после init: in-place denoise одного фрейма. */
export function processFrame(frame: Float32Array, variant: Variant = 'base'): Float32Array {
  const st = states[variant];
  if (!st.loadedSync) throw new Error(`dfn3 (${variant}) not initialised — await init() first`);
  return st.loadedSync.processFrame(frame);
}

export async function destroy(): Promise<void> {
  for (const variant of ['base', 'll'] as Variant[]) {
    const st = states[variant];
    if (st.loadedPromise) {
      const loaded = await st.loadedPromise.catch(() => null);
      loaded?.destroy();
      st.loadedPromise = null;
      st.loadedSync = null;
      st.handleRef = null;
    }
  }
}
