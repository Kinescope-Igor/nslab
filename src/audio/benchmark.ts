/**
 * Microbenchmark всех шумодавов: на одном клиенте (этом ноуте/телефоне)
 * прогоняем фиксированный тестовый сигнал, считаем RTF и per-frame latency.
 *
 * Test signal: 10 sec белого шума + 1 kHz sine (имитирует речь + фон),
 * генерируется per-mode на нужной SR (16/48 kHz). Тишину не подаём —
 * некоторые модели оптимизируют zero-input.
 *
 * Подходы:
 *   - RNNoise/DFN-3/GTCRN: прямой sync (или async) processFrame API,
 *     measure performance.now() вокруг. Самый чистый CPU cost модели.
 *   - DTLN: ScriptProcessorNode → нужен AudioContext. Прогоняем через
 *     OfflineAudioContext.startRendering() и делим wall-time на audio-time.
 *   - WebRTC NS: N/A (native browser APM, нет isolated API).
 *
 * RTF = inference_time / audio_time. RTF < 1 → real-time на этом железе.
 */

import * as rnnoise from './rnnoise';
import * as dfn3 from './dfn3';
import * as gtcrn from './gtcrn';

export interface BenchResult {
  mode: string;
  label: string;
  sampleRate: number;
  audioMs: number;       // длительность прогнанного аудио
  totalInferMs: number;  // суммарное время инференса
  rtf: number;           // totalInferMs / audioMs
  frames: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  note?: string;
}

const DURATION_SEC = 10;

/** Генератор: smooth pink-noise-ish + sine 1 kHz, нормализованный. */
function generateTestSignal(sampleRate: number, durationSec: number): Float32Array {
  const N = Math.round(sampleRate * durationSec);
  const out = new Float32Array(N);
  const sineFreq = 1000;
  const twoPiOverSr = (2 * Math.PI) / sampleRate;
  // pink-ish через простой 3-pole filter
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < N; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    const pink = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    const sine = Math.sin(twoPiOverSr * sineFreq * i) * 0.25;
    out[i] = pink + sine;
  }
  return out;
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function summarize(
  mode: string,
  label: string,
  sampleRate: number,
  audioMs: number,
  perFrameMs: Float32Array,
  note?: string,
): BenchResult {
  const sorted = new Float32Array(perFrameMs);
  sorted.sort();
  let total = 0;
  for (const t of perFrameMs) total += t;
  return {
    mode,
    label,
    sampleRate,
    audioMs,
    totalInferMs: total,
    rtf: total / audioMs,
    frames: perFrameMs.length,
    avgMs: total / perFrameMs.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1],
    note,
  };
}

async function benchSyncFrame(
  mode: string,
  label: string,
  sampleRate: number,
  frameSize: number,
  init: () => Promise<unknown>,
  process: (f: Float32Array) => Float32Array | void,
): Promise<BenchResult> {
  await init();
  const signal = generateTestSignal(sampleRate, DURATION_SEC);
  const numFrames = Math.floor(signal.length / frameSize);
  // Warmup 10 frames (JIT + WASM page-in).
  for (let i = 0; i < 10; i++) process(signal.subarray(0, frameSize).slice());

  const perFrameMs = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const frame = signal.subarray(i * frameSize, (i + 1) * frameSize).slice();
    const t0 = performance.now();
    process(frame);
    perFrameMs[i] = performance.now() - t0;
  }
  return summarize(mode, label, sampleRate, DURATION_SEC * 1000, perFrameMs);
}

async function benchAsyncFrame(
  mode: string,
  label: string,
  sampleRate: number,
  frameSize: number,
  init: () => Promise<unknown>,
  process: (f: Float32Array) => Promise<Float32Array>,
): Promise<BenchResult> {
  await init();
  const signal = generateTestSignal(sampleRate, DURATION_SEC);
  const numFrames = Math.floor(signal.length / frameSize);
  for (let i = 0; i < 10; i++) await process(signal.subarray(0, frameSize).slice());

  const perFrameMs = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const frame = signal.subarray(i * frameSize, (i + 1) * frameSize).slice();
    const t0 = performance.now();
    await process(frame);
    perFrameMs[i] = performance.now() - t0;
  }
  return summarize(mode, label, sampleRate, DURATION_SEC * 1000, perFrameMs);
}

async function benchOfflineNode(
  mode: string,
  label: string,
  sampleRate: number,
  makeNode: (ctx: BaseAudioContext) => AudioNode,
  note?: string,
): Promise<BenchResult> {
  const audioMs = DURATION_SEC * 1000;
  const offlineCtx = new OfflineAudioContext(1, sampleRate * DURATION_SEC, sampleRate);
  const signal = generateTestSignal(sampleRate, DURATION_SEC);
  const buffer = offlineCtx.createBuffer(1, signal.length, sampleRate);
  buffer.copyToChannel(signal, 0);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  const node = makeNode(offlineCtx);
  src.connect(node);
  node.connect(offlineCtx.destination);
  src.start(0);

  const t0 = performance.now();
  await offlineCtx.startRendering();
  const elapsed = performance.now() - t0;

  // Один pseudo-frame со всей длительностью — детальной p95 не получим.
  const perFrameMs = new Float32Array([elapsed]);
  const r = summarize(mode, label, sampleRate, audioMs, perFrameMs, note);
  // У offline bench нет per-frame distribution — обнуляем перцентили.
  r.p50Ms = r.p95Ms = r.p99Ms = r.maxMs = r.avgMs;
  return r;
}

export async function runAllBenchmarks(
  onProgress?: (current: string, done: number, total: number) => void,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const steps = [
    async () => {
      onProgress?.('RNNoise', 0, 4);
      const loaded = await rnnoise.init();
      return benchSyncFrame(
        'rnnoise',
        'RNNoise',
        48000,
        loaded.frameSize,
        async () => loaded,
        (f) => { rnnoise.processFrame(f); },
      );
    },
    async () => {
      onProgress?.('DFN-3', 1, 4);
      const loaded = await dfn3.init();
      return benchSyncFrame(
        'dfn3',
        'DeepFilterNet 3',
        48000,
        loaded.frameSize,
        async () => loaded,
        (f) => { dfn3.processFrame(f); },
      );
    },
    async () => {
      onProgress?.('GTCRN', 2, 4);
      const loaded = await gtcrn.init();
      return benchAsyncFrame(
        'gtcrn',
        'GTCRN',
        16000,
        loaded.frameSize,
        async () => loaded,
        (f) => gtcrn.processFrameAsync(f),
      );
    },
    async () => {
      onProgress?.('DTLN', 3, 4);
      const dtln = await import('./dtln');
      const api = await dtln.init();
      return benchOfflineNode(
        'dtln',
        'DTLN-rs',
        api.sampleRate,
        (ctx) => api.createNode(ctx),
        'wall-time через OfflineAudioContext (включает framework overhead, RTF ≈ верхняя оценка)',
      );
    },
  ];
  for (const step of steps) {
    try {
      results.push(await step());
    } catch (err) {
      console.error('benchmark step failed', err);
    }
  }
  onProgress?.('готово', 4, 4);
  return results;
}
