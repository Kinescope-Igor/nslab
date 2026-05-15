import { defineConfig } from 'vite';

// COOP/COEP заголовки включают SharedArrayBuffer → tflite-runtime в dtln-web
// поднимает threaded XNNPACK и спавнит много worker thread'ов под main-thread
// ScriptProcessorNode → tab вешается. Отключаем для dev. dtln-web fallback'нет
// на cc_simd (non-threaded), что в нашем сценарии работает стабильно.
//
// Когда подключим DFN-3 (onnxruntime-web с threaded SIMD), либо включим
// заголовки обратно с другим setup tflite, либо пустим DFN тоже non-threaded.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(_server: any) {
    // intentionally empty: см. комментарий выше
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
