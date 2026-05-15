/**
 * Копирует DTLN-runtime файлы из node_modules в public/dtln-web/.
 * Запускается автоматически через postinstall (см. package.json).
 *
 * Cross-platform Node.js версия (заменяет copy-dtln-assets.sh — bash на Windows
 * CI не работает).
 *
 * @sapphi-red/dtln-web на старте определяет capabilities браузера и грузит
 * подходящий вариант: simd / simd_threaded (если есть SAB+COEP/COOP).
 * Поэтому копируем все 4 варианта tflite-runtime + соответствующие worker'ы.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'node_modules', '@sapphi-red', 'dtln-web', 'dist');
const DST = join(ROOT, 'public', 'dtln-web');

if (!existsSync(SRC)) {
  console.log(`skip: ${SRC} не существует (пакет не установлен)`);
  process.exit(0);
}

mkdirSync(DST, { recursive: true });

const files = [
  // Модели DTLN: quant=dynamic (~1 MB total) — в 2-3 раза легче по CPU,
  // чем full-precision. Для real-time-monitor через ScriptProcessorNode критично.
  'model_quant_dynamic_1.tflite',
  'model_quant_dynamic_2.tflite',
];

// Только non-threaded варианты tflite WASM. Threaded варианты вызывают
// CPU starvation на main-thread ScriptProcessorNode (см. vite.config.ts).
// dtln-web запросит threaded → 404 → fallback на cc_simd.
for (const variant of ['cc', 'cc_simd']) {
  files.push(`tflite_web_api_${variant}.wasm`);
  files.push(`tflite_web_api_${variant}.js`);
}

for (const f of files) {
  const src = join(SRC, f);
  const dst = join(DST, f);
  if (!existsSync(src)) {
    console.warn(`  ! ${f} отсутствует в ${SRC}`);
    continue;
  }
  copyFileSync(src, dst);
}

const totalBytes = readdirSync(DST).reduce((sum, f) => sum + statSync(join(DST, f)).size, 0);
const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
console.log(`DTLN assets copied → ${DST} (${readdirSync(DST).length} files, ${totalMb} MB)`);
