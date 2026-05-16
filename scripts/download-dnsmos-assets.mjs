/**
 * Скачивает DNSMOS P.835 модель в public/dnsmos/.
 *
 * Источник: github.com/microsoft/DNS-Challenge/tree/master/DNSMOS/DNSMOS — MIT.
 * Используем sig_bak_ovr.onnx — primary model (1.16 MB), берёт raw audio
 * 16 kHz моно, отдаёт [SIG, BAK, OVRL]. P808 опционально, не качаем.
 */

import { existsSync, mkdirSync, createWriteStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DST = join(ROOT, 'public', 'dnsmos');

const ASSETS = [
  {
    url: 'https://raw.githubusercontent.com/microsoft/DNS-Challenge/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx',
    path: 'sig_bak_ovr.onnx',
  },
];

mkdirSync(DST, { recursive: true });

for (const a of ASSETS) {
  const dst = join(DST, a.path);
  if (existsSync(dst) && statSync(dst).size > 0) {
    console.log(`  skip (exists): ${a.path}`);
    continue;
  }
  console.log(`  download: ${a.url}`);
  try {
    const res = await fetch(a.url);
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    await finished(Readable.fromWeb(res.body).pipe(createWriteStream(dst)));
    const sizeMb = (statSync(dst).size / 1024 / 1024).toFixed(2);
    console.log(`           → ${dst} (${sizeMb} MB)`);
  } catch (err) {
    console.warn(`  ! fail: ${err.message}`);
  }
}

console.log(`DNSMOS assets ready in ${DST}`);
