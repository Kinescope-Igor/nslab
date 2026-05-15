/**
 * Скачивает DeepFilterNet 3 ассеты (WASM + модель) в public/dfn3/.
 *
 * Default CDN библиотеки (cdn.laptrinhai.id.vn) НЕ отдаёт CORS-заголовки →
 * браузер блокирует fetch с другого origin. Поэтому self-host'им: качаем
 * файлы один раз, отдаём со своего домена через cdnUrl: '/dfn3/'.
 *
 * Запускается из postinstall, идемпотентен (skip если файлы уже есть).
 */

import { existsSync, mkdirSync, createWriteStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DST = join(ROOT, 'public', 'dfn3');

const CDN = 'https://cdn.laptrinhai.id.vn/deepfilternet3';
const ASSETS = [
  { url: `${CDN}/pkg/df_bg.wasm`, path: 'pkg/df_bg.wasm' },
  { url: `${CDN}/models/DeepFilterNet3_onnx.tar.gz`, path: 'models/DeepFilterNet3_onnx.tar.gz' },
];

async function download(url, dstPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  const stream = createWriteStream(dstPath);
  await finished(Readable.fromWeb(res.body).pipe(stream));
}

mkdirSync(DST, { recursive: true });

for (const a of ASSETS) {
  const dst = join(DST, a.path);
  if (existsSync(dst) && statSync(dst).size > 0) {
    console.log(`  skip (exists): ${a.path}`);
    continue;
  }
  console.log(`  download: ${a.url}`);
  try {
    await download(a.url, dst);
    const sizeMb = (statSync(dst).size / 1024 / 1024).toFixed(1);
    console.log(`           → ${dst} (${sizeMb} MB)`);
  } catch (err) {
    console.warn(`  ! fail: ${err.message} (DFN-3 не будет работать без этого)`);
  }
}

console.log(`DFN-3 assets ready in ${DST}`);
