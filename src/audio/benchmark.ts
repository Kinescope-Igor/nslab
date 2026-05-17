/**
 * Microbenchmark всех шумодавов: на одном клиенте прогоняем фиксированный
 * 10-sec тестовый сигнал @ 48 kHz (как реальный mic), для 16 kHz моделей
 * декимируем 48→16 ВНУТРИ измерения. Резюмируем RTF, cold/steady latency,
 * p50/p95/p99 и memory delta.
 *
 * Источник: pink noise + 1 kHz sine. Тишину не подаём — модели могут
 * оптимизировать zero-input.
 *
 * Подходы:
 *   - RNNoise/DFN-3: sync processFrame, 48k signal без resample.
 *   - GTCRN: async processFrameAsync, resample 48→16 внутри per-frame timing.
 *     Прогоняется по всем доступным ORT backends (wasm / webgpu / webnn).
 *   - DTLN: ScriptProcessorNode → OfflineAudioContext @ 16k, signal заранее
 *     decimate'нут (resample входит в wall-time).
 *   - WebRTC NS: N/A (native APM, isolated API нет).
 *
 * Memory: performance.memory.usedJSHeapSize delta (Chromium-only).
 *
 * Cold vs warm: per-frame timing с самого первого фрейма → coldMs.
 * steadyAvg / p50 / p95 / p99 считаются по фреймам со 2-го (без cold-spike).
 */

import * as rnnoise from './rnnoise';
import * as dfn3 from './dfn3';
import * as gtcrn from './gtcrn';
import type { Backend as GtcrnBackend } from './gtcrn';

export interface BenchResult {
  mode: string;
  label: string;
  backend: string;
  sampleRate: number;       // native SR модели
  frameSize: number;        // samples per frame at native SR
  audioMs: number;
  totalInferMs: number;
  rtf: number;
  frames: number;
  coldMs: number;           // первый frame целиком (init/JIT/page-in эффекты)
  steadyAvgMs: number;      // среднее со 2-го frame
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  memMb: number | null;
  note?: string;
}

const DURATION_SEC = 10;
const MIC_SR = 48000;

function generateTestSignal(sampleRate: number, durationSec: number): Float32Array {
  const N = Math.round(sampleRate * durationSec);
  const out = new Float32Array(N);
  const twoPiOverSr = (2 * Math.PI) / sampleRate;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < N; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    const pink = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    const sine = Math.sin(twoPiOverSr * 1000 * i) * 0.25;
    out[i] = pink + sine;
  }
  return out;
}

/** Anti-alias-decimate 48 kHz → 16 kHz усреднением 3-tap window. */
function decimate3(input: Float32Array, out?: Float32Array): Float32Array {
  const N = Math.floor(input.length / 3);
  const dst = out ?? new Float32Array(N);
  for (let i = 0; i < N; i++) {
    dst[i] = (input[i * 3] + input[i * 3 + 1] + input[i * 3 + 2]) / 3;
  }
  return dst;
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function snapMem(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m?.usedJSHeapSize ?? null;
}

function summarize(
  mode: string,
  label: string,
  backend: string,
  sampleRate: number,
  frameSize: number,
  audioMs: number,
  perFrameMs: Float32Array,
  memDeltaBytes: number | null,
  note?: string,
): BenchResult {
  const cold = perFrameMs[0] ?? 0;
  let total = 0;
  for (const t of perFrameMs) total += t;

  const warmSlice = perFrameMs.length > 1 ? perFrameMs.subarray(1) : perFrameMs;
  const sorted = new Float32Array(warmSlice).sort();
  let totalWarm = 0;
  for (const t of warmSlice) totalWarm += t;

  return {
    mode,
    label,
    backend,
    sampleRate,
    frameSize,
    audioMs,
    totalInferMs: total,
    rtf: total / audioMs,
    frames: perFrameMs.length,
    coldMs: cold,
    steadyAvgMs: warmSlice.length > 0 ? totalWarm / warmSlice.length : cold,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.length ? sorted[sorted.length - 1] : cold,
    memMb: memDeltaBytes != null ? +(memDeltaBytes / (1024 * 1024)).toFixed(1) : null,
    note,
  };
}

/**
 * Benchmark с pre-rendered 48k signal. Если модель native 16k —
 * декимация 48→16 включается ВНУТРИ measured region (имитирует
 * real-world mic chain).
 */
async function benchPerFrame(opts: {
  mode: string;
  label: string;
  backend: string;
  signal48: Float32Array;
  nativeSr: number;            // 48000 или 16000
  frameSize: number;           // native-SR samples per call
  process: (f: Float32Array) => Float32Array | void | Promise<Float32Array | void>;
}): Promise<BenchResult> {
  const { mode, label, backend, signal48, nativeSr, frameSize, process } = opts;
  const isResample = nativeSr !== MIC_SR;
  const frameSize48 = frameSize * (MIC_SR / nativeSr);
  const numFrames = Math.floor(signal48.length / frameSize48);
  const perFrameMs = new Float32Array(numFrames);
  const reusableFrame = new Float32Array(frameSize);

  for (let i = 0; i < numFrames; i++) {
    const start = i * frameSize48;
    const t0 = performance.now();
    let frame: Float32Array;
    if (isResample) {
      const src = signal48.subarray(start, start + frameSize48);
      decimate3(src, reusableFrame);
      frame = reusableFrame.slice();
    } else {
      frame = signal48.subarray(start, start + frameSize48).slice();
    }
    const r = process(frame);
    if (r && typeof (r as Promise<unknown>).then === 'function') await r;
    perFrameMs[i] = performance.now() - t0;
  }
  return summarize(mode, label, backend, nativeSr, frameSize, DURATION_SEC * 1000, perFrameMs, null);
}

/** DTLN: ScriptProcessor → OfflineAudioContext, pre-resample внутри measured. */
async function benchDtln(): Promise<BenchResult> {
  const dtln = await import('./dtln');
  const memBefore = snapMem();
  const api = await dtln.init();
  const memDelta = memBefore != null && snapMem() != null ? (snapMem()! - memBefore) : null;

  const audioMs = DURATION_SEC * 1000;
  const signal48 = generateTestSignal(MIC_SR, DURATION_SEC);

  const t0 = performance.now();
  // Resample 48→16 входит в total.
  const signal16 = decimate3(signal48);
  const offlineCtx = new OfflineAudioContext(1, signal16.length, api.sampleRate);
  const buffer = offlineCtx.createBuffer(1, signal16.length, api.sampleRate);
  buffer.copyToChannel(signal16, 0);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  const node = api.createNode(offlineCtx);
  src.connect(node);
  node.connect(offlineCtx.destination);
  src.start(0);
  await offlineCtx.startRendering();
  const elapsed = performance.now() - t0;

  const perFrameMs = new Float32Array([elapsed]);
  const r = summarize(
    'dtln', 'DTLN-rs', 'wasm (xnnpack)', api.sampleRate, 0, audioMs, perFrameMs, memDelta,
    'wall-time через OfflineAudioContext (resample 48→16 + render), per-frame stat недоступен',
  );
  r.coldMs = elapsed;
  r.steadyAvgMs = elapsed;
  r.p50Ms = r.p95Ms = r.p99Ms = r.maxMs = elapsed;
  return r;
}

async function detectBackends(): Promise<GtcrnBackend[]> {
  const available: GtcrnBackend[] = ['wasm'];
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) available.push('webgpu');
  } catch { /* not supported */ }
  if ('ml' in navigator) available.push('webnn');
  return available;
}

export async function runAllBenchmarks(
  onProgress?: (current: string, done: number, total: number) => void,
): Promise<BenchResult[]> {
  const gtcrnBackends = await detectBackends();
  const results: BenchResult[] = [];
  const signal48 = generateTestSignal(MIC_SR, DURATION_SEC);

  type Step = { name: string; run: () => Promise<BenchResult> };
  const steps: Step[] = [
    {
      name: 'RNNoise (wasm)',
      run: async () => {
        const memBefore = snapMem();
        const loaded = await rnnoise.init();
        const memDelta = memBefore != null && snapMem() != null ? (snapMem()! - memBefore) : null;
        const r = await benchPerFrame({
          mode: 'rnnoise', label: 'RNNoise', backend: 'wasm',
          signal48, nativeSr: 48000, frameSize: loaded.frameSize,
          process: (f) => { rnnoise.processFrame(f); },
        });
        r.memMb = memDelta != null ? +(memDelta / (1024 * 1024)).toFixed(1) : null;
        return r;
      },
    },
    {
      name: 'DFN-3 (wasm libDF)',
      run: async () => {
        const memBefore = snapMem();
        const loaded = await dfn3.init();
        const memDelta = memBefore != null && snapMem() != null ? (snapMem()! - memBefore) : null;
        const r = await benchPerFrame({
          mode: 'dfn3', label: 'DeepFilterNet 3', backend: 'wasm (libDF)',
          signal48, nativeSr: 48000, frameSize: loaded.frameSize,
          process: (f) => { dfn3.processFrame(f); },
        });
        r.memMb = memDelta != null ? +(memDelta / (1024 * 1024)).toFixed(1) : null;
        return r;
      },
    },
    ...gtcrnBackends.map((backend): Step => ({
      name: `GTCRN (${backend})`,
      run: async () => {
        const memBefore = snapMem();
        const sess = await gtcrn.createSession(backend);
        const memDelta = memBefore != null && snapMem() != null ? (snapMem()! - memBefore) : null;
        try {
          const r = await benchPerFrame({
            mode: 'gtcrn', label: 'GTCRN', backend,
            signal48, nativeSr: 16000, frameSize: sess.frameSize,
            process: (f) => sess.processFrame(f),
          });
          r.memMb = memDelta != null ? +(memDelta / (1024 * 1024)).toFixed(1) : null;
          return r;
        } finally {
          await sess.destroy();
        }
      },
    })),
    {
      name: 'DTLN (wasm xnnpack)',
      run: () => benchDtln(),
    },
  ];

  for (let i = 0; i < steps.length; i++) {
    onProgress?.(steps[i].name, i, steps.length);
    try {
      results.push(await steps[i].run());
    } catch (err) {
      console.error('benchmark step failed', steps[i].name, err);
    }
  }
  onProgress?.('готово', steps.length, steps.length);
  return results;
}
