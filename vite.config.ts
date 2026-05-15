import { defineConfig } from 'vite';

// COOP/COEP заголовки включают SharedArrayBuffer — нужны для DFN-3 WASM
// (df_bg.wasm бросает RuntimeError: unreachable без них при инициализации
// модели). На DTLN сторону эти заголовки тоже влияют: tflite-runtime тогда
// выбирает threaded XNNPACK и спавнит worker thread'ы → main-thread
// ScriptProcessorNode голодает → tab вешается.
//
// Решение: COOP/COEP включены, а в public/dtln-web/ оставляем ТОЛЬКО
// non-threaded SIMD варианты tflite-runtime (см. copy-dtln-assets.mjs) —
// dtln-web запросит threaded.wasm → 404 → fallback на cc_simd.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
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
