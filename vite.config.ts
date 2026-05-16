import { defineConfig } from 'vite';

// COOP/COEP отключены: с включёнными заголовками tflite-runtime в dtln-web
// автоматически выбирает _simd_threaded.js → spawn worker threads →
// main-thread ScriptProcessorNode голодает → tab вешается.
//
// Без SAB tflite берёт cc_simd.js (non-threaded), DTLN работает стабильно.
// DFN-3 (deepfilter-standalone) пока не работает в этой конфигурации —
// бросает RuntimeError: unreachable в df_create() даже без зависимости
// от SAB. Корень не выяснен (возможно, model/wasm несовместимость на CDN).
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(_server: any) {
    // intentionally empty
  },
};

export default defineConfig({
  base: './',
  plugins: [crossOriginIsolation],
  server: {
    host: true,
    port: 5173,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
