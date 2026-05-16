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
  // Модели DTLN: full-precision (~4 MB total). После того как DNSMOS уехал
  // в Worker (главный thread свободен), full-precision должен потянуть и
  // даёт заметно лучше качество, чем quant_dynamic.
  'model_1.tflite',
  'model_2.tflite',
];

// Все 4 варианта tflite WASM. tflite-web feature-detection жёстко выбирает
// конкретный по capabilities (simd × multiThreading) и НЕ fallback'ит на 404 →
// нужны все. Зависание DTLN из-за threaded XNNPACK в прошлой итерации, скорее
// всего, было следствием race-condition в pipeline (исправлено в P0 #1
// opChain mutex), а не нагрузки worker thread'ов.
for (const variant of ['cc', 'cc_simd', 'cc_threaded', 'cc_simd_threaded']) {
  files.push(`tflite_web_api_${variant}.wasm`);
  files.push(`tflite_web_api_${variant}.js`);
  if (variant.endsWith('threaded')) {
    files.push(`tflite_web_api_${variant}.worker.js`);
  }
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
