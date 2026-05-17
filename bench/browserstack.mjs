#!/usr/bin/env node
/**
 * BrowserStack App Automate (Appium) runner для NSLab бенчмарка.
 *
 * Что делает: для каждого устройства из matrix.mjs открывает
 * https://speak.kn.pe/lab/noise-bench/, ждёт кнопку «Бенчмарк», кликает,
 * ждёт window.__nslabBench, забирает results и пишет в JSON + Markdown.
 *
 * Запуск:
 *   1. Положи .env.local с BROWSERSTACK_USERNAME и BROWSERSTACK_ACCESS_KEY
 *      (см. .env.local.example).
 *   2. npm run bench:bs
 *
 * Выходные файлы — bench/out/results-{ISO-date}.{json,md}.
 *
 * Sequential prog: 1 сессия за раз. Если нужен parallel — добавить
 * Promise.all + флаг --parallel (BS лимит ~5 для базового Automate Mobile).
 */

import dotenv from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Совместимо с Vite-конвенцией: .env.local (gitignored) приоритетнее .env
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'selenium-webdriver';
const { Builder, By, until } = pkg;

import { matrix, toCaps, TEST } from './matrix.mjs';

// CLI флаги:
//   --only <substr>   — фильтр по spec.name (case-insensitive)
//   --kind mobile|desktop — фильтр по типу (для запуска только одной группы)
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1]?.toLowerCase() : null;
const kindIdx = args.indexOf('--kind');
const KIND = kindIdx >= 0 ? args[kindIdx + 1] : null;
let filteredMatrix = matrix;
if (KIND) filteredMatrix = filteredMatrix.filter((m) => m.kind === KIND);
if (ONLY) filteredMatrix = filteredMatrix.filter((m) => m.name.toLowerCase().includes(ONLY));

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const HUB_URL = 'https://hub-cloud.browserstack.com/wd/hub';
const BENCH_TIMEOUT_MS = 360_000; // 6 мин (Firefox macOS на 240s падал — увеличено)

function assertEnv() {
  if (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY) {
    console.error('!!! BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY не заданы.');
    console.error('    Создай .env.local (см. .env.local.example).');
    process.exit(1);
  }
}

async function runOne(spec) {
  const caps = toCaps(spec);
  const driver = await new Builder()
    .usingServer(HUB_URL)
    .withCapabilities(caps)
    .build();

  const sessionId = (await driver.getSession()).getId();
  console.log(`▶ ${spec.name} → sessionId=${sessionId}`);
  console.log(`  dashboard: https://app-automate.browserstack.com/dashboard/v2/builds`);

  try {
    await driver.get(TEST.url);

    // Ждём, пока кнопка появится — это значит main bundle загрузился.
    const btn = await driver.wait(until.elementLocated(By.id('btn-bench')), 60_000);
    await driver.wait(until.elementIsEnabled(btn), 60_000);

    // Дайте странице полностью отрисоваться + WASM-модули lazy-init.
    await new Promise((r) => setTimeout(r, 1500));

    await btn.click();

    // Ждём, пока бенчмарк закончится: window.__nslabBench становится array.
    const results = await driver.wait(async () => {
      const r = await driver.executeScript('return window.__nslabBench || null;');
      return r && r.length ? r : null;
    }, BENCH_TIMEOUT_MS, `Бенчмарк не закончился за ${BENCH_TIMEOUT_MS / 1000}s`);

    const ua = await driver.executeScript('return navigator.userAgent;');

    // Browser console logs (если capture поддерживается этим device) —
    // полезно для отладки failed-step (например GTCRN не инициализируется
    // в iOS Safari из-за SharedArrayBuffer/CSP/etc).
    let consoleLogs = [];
    try {
      const logs = await driver.manage().logs().get('browser');
      consoleLogs = logs.map((l) => ({ level: l.level.name, msg: l.message }));
    } catch { /* not all drivers expose logs */ }

    const sessionStatus = { status: 'passed', reason: `bench ok, ${results.length} rows` };
    await driver.executeScript(
      `browserstack_executor: ${JSON.stringify({ action: 'setSessionStatus', arguments: sessionStatus })}`,
    );

    return { spec, ua, results, consoleLogs, ok: true };
  } catch (err) {
    console.error(`  ✗ ${spec.name}: ${err.message}`);
    try {
      await driver.executeScript(
        `browserstack_executor: ${JSON.stringify({
          action: 'setSessionStatus',
          arguments: { status: 'failed', reason: String(err.message).slice(0, 200) },
        })}`,
      );
    } catch { /* ignore */ }
    return { spec, ok: false, error: err.message };
  } finally {
    await driver.quit().catch(() => {});
  }
}

function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 10) return n.toFixed(digits);
  return n.toFixed(1);
}

function toMarkdown(allRuns) {
  let out = `# NSLab BrowserStack benchmark · ${TEST.build}\n\n`;
  out += `URL: ${TEST.url}\n\n`;
  out += `| Device | Model | Backend | RTF | cold ms | p50 | p95 | p99 | Mem MB | SR |\n`;
  out += `|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const run of allRuns) {
    if (!run.ok) {
      out += `| ${run.spec.name} | _failed_ | — | — | — | — | — | — | — | — |\n`;
      continue;
    }
    for (const r of run.results) {
      out += `| ${run.spec.name} | ${r.label} | ${r.backend} | ${fmt(r.rtf, 3)} | ${fmt(r.coldMs)} | ${fmt(r.p50Ms)} | ${fmt(r.p95Ms)} | ${fmt(r.p99Ms)} | ${fmt(r.memMb)} | ${(r.sampleRate / 1000).toFixed(0)}k |\n`;
    }
  }
  out += `\nGenerated at ${new Date().toISOString()}\n`;
  return out;
}

async function main() {
  assertEnv();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  if (ONLY && filteredMatrix.length === 0) {
    console.error(`!!! --only "${ONLY}" не дал ни одного совпадения. Полная матрица:`);
    for (const m of matrix) console.error(`  - ${m.name}`);
    process.exit(2);
  }
  console.log(`▶ Запуск ${filteredMatrix.length}/${matrix.length} устройств → ${TEST.url}`);
  console.log(`  (sequential, ~2-3 мин на устройство${ONLY ? `, filter="${ONLY}"` : ''})\n`);

  const t0 = Date.now();
  const runs = [];
  for (const spec of filteredMatrix) {
    let r;
    try {
      r = await runOne(spec);
    } catch (err) {
      // Build/connect failure (например device не каталогизирован на BS) —
      // ловим здесь, чтобы один сбой не убивал прогон по остальным устройствам.
      r = { spec, ok: false, error: err.message || String(err) };
      console.error(`  ✗ ${spec.name} (build failed): ${r.error}`);
    }
    runs.push(r);
    if (r.ok) console.log(`  ✓ ${spec.name}: ${r.results.length} строк`);
  }
  const tTotal = ((Date.now() - t0) / 1000).toFixed(1);

  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const jsonPath = join(OUT_DIR, `results-${stamp}.json`);
  const mdPath = join(OUT_DIR, `results-${stamp}.md`);

  writeFileSync(jsonPath, JSON.stringify({
    build: TEST.build,
    url: TEST.url,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec: +tTotal,
    runs,
  }, null, 2));
  writeFileSync(mdPath, toMarkdown(runs));

  const ok = runs.filter((r) => r.ok).length;
  const fail = runs.length - ok;
  console.log(`\nГотово за ${tTotal}s · ok=${ok} · fail=${fail}`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
