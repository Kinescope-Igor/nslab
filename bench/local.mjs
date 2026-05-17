#!/usr/bin/env node
/**
 * Local desktop benchmark runner через Playwright.
 *
 * Запускает три локальных движка: Chromium (Blink), Firefox (Gecko),
 * WebKit (Safari engine). Каждый открывает https://speak.kn.pe/lab/noise-bench/,
 * кликает #btn-bench, ждёт window.__nslabBench, пишет JSON+MD в bench/out/.
 *
 * Зачем: BrowserStack «Automate Mobile» план покрывает только мобильные
 * устройства; desktop browsers требуют отдельного плана. До его получения
 * локальный runner на разработческой машине — рабочий suррогат.
 *
 * Запуск:
 *   npm run bench:local           # все 3 движка
 *   npm run bench:local -- --only chromium
 *
 * Если нужно реальное Edge / реальное Chrome (channel) — играй с
 * --browser в коде; Playwright поддерживает channel: 'msedge' | 'chrome'.
 */

import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const URL = process.env.NSLAB_URL || 'https://speak.kn.pe/lab/noise-bench/';
const BUILD = `nslab-local-${new Date().toISOString().slice(0, 10)}`;
const BENCH_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1]?.toLowerCase() : null;

// На каждом OS Playwright возьмёт свои bundled browsers. Хост-имя из uname/os.platform()
// потом попадёт в результат, чтобы можно было микшировать прогоны Mac+Win+Linux.
const engines = [
  { name: 'Chromium (Blink)', launcher: chromium, hint: 'desktop' },
  { name: 'Firefox (Gecko)', launcher: firefox, hint: 'desktop' },
  { name: 'WebKit (Safari engine)', launcher: webkit, hint: 'desktop' },
];

async function runOne({ name, launcher }) {
  const t0 = Date.now();
  console.log(`▶ ${name}`);
  const browser = await launcher.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      // Имитируем user-gesture для AudioContext — кликом по кнопке;
      // для генерации тест-сигнала mic не нужен.
      permissions: [],
    });
    const page = await ctx.newPage();

    const consoleLogs = [];
    page.on('console', (msg) => consoleLogs.push({ level: msg.type(), msg: msg.text() }));
    page.on('pageerror', (err) => consoleLogs.push({ level: 'pageerror', msg: err.message }));

    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('#btn-bench', { timeout: 30_000 });
    await page.click('#btn-bench');

    const results = await page.waitForFunction(
      () => window.__nslabBench || null,
      null,
      { timeout: BENCH_TIMEOUT_MS, polling: 1000 },
    ).then((h) => h.jsonValue());

    const ua = await page.evaluate(() => navigator.userAgent);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ ${name}: ${results.length} строк за ${dt}s`);

    return {
      spec: { name, hint: 'desktop' },
      ua,
      results,
      consoleLogs: consoleLogs.slice(-20),
      ok: true,
    };
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    return { spec: { name }, ok: false, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 10) return n.toFixed(digits);
  return n.toFixed(1);
}

function toMarkdown(runs, platform) {
  let out = `# NSLab local desktop benchmark · ${BUILD}\n\n`;
  out += `URL: ${URL}\n`;
  out += `Host: ${platform}\n\n`;
  out += `| Engine | Model | Backend | RTF | cold ms | p50 | p95 | p99 | Mem MB | SR |\n`;
  out += `|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const r of runs) {
    if (!r.ok) {
      out += `| ${r.spec.name} | _failed_ | — | — | — | — | — | — | — | — |\n`;
      continue;
    }
    for (const b of r.results) {
      out += `| ${r.spec.name} | ${b.label} | ${b.backend} | ${fmt(b.rtf, 3)} | ${fmt(b.coldMs)} | ${fmt(b.p50Ms)} | ${fmt(b.p95Ms)} | ${fmt(b.p99Ms)} | ${fmt(b.memMb)} | ${(b.sampleRate / 1000).toFixed(0)}k |\n`;
    }
  }
  out += `\nGenerated at ${new Date().toISOString()}\n`;
  return out;
}

async function main() {
  const filtered = ONLY
    ? engines.filter((e) => e.name.toLowerCase().includes(ONLY))
    : engines;

  if (filtered.length === 0) {
    console.error(`!!! --only "${ONLY}" не дал совпадений. Доступные:`);
    for (const e of engines) console.error(`  - ${e.name}`);
    process.exit(2);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const platform = `${process.platform} ${process.arch}`;

  console.log(`▶ Local desktop bench · ${platform} · ${filtered.length}/${engines.length} движков\n`);

  const t0 = Date.now();
  const runs = [];
  for (const e of filtered) {
    try {
      runs.push(await runOne(e));
    } catch (err) {
      runs.push({ spec: { name: e.name }, ok: false, error: err.message });
    }
  }
  const tTotal = ((Date.now() - t0) / 1000).toFixed(1);

  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const jsonPath = join(OUT_DIR, `results-local-${platform.replace(/ /g, '-')}-${stamp}.json`);
  const mdPath = join(OUT_DIR, `results-local-${platform.replace(/ /g, '-')}-${stamp}.md`);

  writeFileSync(jsonPath, JSON.stringify({
    build: BUILD,
    platform,
    url: URL,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec: +tTotal,
    runs,
  }, null, 2));
  writeFileSync(mdPath, toMarkdown(runs, platform));

  const ok = runs.filter((r) => r.ok).length;
  console.log(`\nГотово за ${tTotal}s · ok=${ok}/${runs.length}`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
