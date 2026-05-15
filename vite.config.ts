import { defineConfig } from 'vite';

// COOP/COEP заголовки нужны для SharedArrayBuffer (онxruntime-web threaded, dtln-rs threaded).
// На kn.pe/lab/noise-bench их выставит nginx; в dev-режиме — Vite.
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
