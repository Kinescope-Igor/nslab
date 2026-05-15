/**
 * Аудио-pipeline с hot-swap между NS-режимами.
 *
 * raw         → 48 kHz AudioContext + passthrough worklet
 * rnnoise     → 48 kHz AudioContext + forwarder worklet + RNNoise в main thread
 * dtln        → 16 kHz AudioContext + ScriptProcessorNode (TFLite DTLN)
 * dfn3        → TODO
 *
 * Так как RNNoise требует 48 kHz, а DTLN — 16 kHz, при смене режима
 * пересоздаём AudioContext с правильным sampleRate.
 *
 * Все публичные операции (start / stop / setMode) сериализуются через
 * opChain — иначе два параллельных вызова перетирают state.
 */

import passthroughUrl from '../worklets/passthrough.js?url';
import forwarderUrl from '../worklets/forwarder.js?url';
import * as rnnoise from './rnnoise';
import * as dtln from './dtln';

export type Mode = 'raw' | 'rnnoise' | 'dtln' | 'dfn3';

const SAMPLE_RATE: Record<Mode, number> = {
  raw: 48000,
  rnnoise: 48000,
  dtln: 16000,
  dfn3: 48000,
};

export interface PipelineState {
  context: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  node: AudioNode | null;
  mode: Mode;
  onRms?: (dbfs: number) => void;
  onVad?: (vad: number) => void;
}

export const state: PipelineState = {
  context: null,
  stream: null,
  source: null,
  node: null,
  mode: 'raw',
};

// Сериализатор операций: каждая публичная функция выполняется только после
// завершения предыдущей. Ошибки в op'ах не блокируют chain.
let opChain: Promise<void> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = opChain.then(fn, fn);
  opChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function start(): Promise<void> {
  return enqueue(async () => {
    if (state.context) return;
    await reinitContext(state.mode);
  });
}

export function stop(): Promise<void> {
  return enqueue(async () => {
    await teardown();
  });
}

export function setMode(mode: Mode): Promise<void> {
  return enqueue(async () => {
    state.mode = mode;
    if (!state.context) return;
    if (state.context.sampleRate === SAMPLE_RATE[mode]) {
      await applyMode(mode);
    } else {
      await teardown();
      await reinitContext(mode);
    }
  });
}

async function teardown(): Promise<void> {
  // Снимаем obрабочики port — closure не должен дёргать state после disconnect.
  if (state.node && 'port' in state.node) {
    (state.node as AudioWorkletNode).port.onmessage = null;
  }
  state.node?.disconnect();
  state.source?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  await state.context?.close();

  state.context = null;
  state.stream = null;
  state.source = null;
  state.node = null;
}

async function reinitContext(mode: Mode): Promise<void> {
  // 1. Сначала запрашиваем mic. Если permission denied — throw до создания
  //    AudioContext, state остаётся нулевым → следующий start() сработает.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Отключаем браузерный APM — мы тестируем ИМЕННО наши шумодавы.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // 2. Создаём context (если на этом этапе кто-то отменит — освобождаем mic).
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE[mode] });
    await context.audioWorklet.addModule(passthroughUrl);
    await context.audioWorklet.addModule(forwarderUrl);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  state.context = context;
  state.stream = stream;
  state.source = context.createMediaStreamSource(stream);
  await applyMode(mode);
}

async function applyMode(mode: Mode): Promise<void> {
  if (!state.context || !state.source) return;

  // 1. СНАЧАЛА разрываем старую цепочку — иначе на момент swap source отдаёт
  //    звук в обе цепочки и юзер слышит сумму raw + denoised.
  if (state.node && 'port' in state.node) {
    (state.node as AudioWorkletNode).port.onmessage = null;
  }
  state.source.disconnect();
  state.node?.disconnect();
  state.node = null;

  // 2. Создаём новый узел и инициализируем модель (если нужно).
  let newNode: AudioNode;

  if (mode === 'raw') {
    const w = new AudioWorkletNode(state.context, 'passthrough-processor');
    w.port.onmessage = (e) => {
      if (e.data?.type === 'rms') state.onRms?.(e.data.dbfs);
    };
    newNode = w;
  } else if (mode === 'rnnoise') {
    const loaded = await rnnoise.init();
    const w = new AudioWorkletNode(state.context, 'forwarder-processor', {
      processorOptions: { frameSize: loaded.frameSize },
    });
    w.port.onmessage = async (e) => {
      if (e.data?.type === 'frame') {
        const frame = e.data.frame as Float32Array;
        const vad = await rnnoise.processFrame(frame);
        // Если nodes свапнули, port уже закрыт — postMessage просто no-op.
        w.port.postMessage({ type: 'processed', frame }, [frame.buffer]);
        state.onVad?.(vad);
      } else if (e.data?.type === 'rms') {
        state.onRms?.(e.data.dbfs);
      }
    };
    newNode = w;
  } else if (mode === 'dtln') {
    const api = await dtln.init();
    newNode = api.createNode(state.context);
    state.onVad?.(NaN);
  } else {
    // dfn3 — TODO
    newNode = new AudioWorkletNode(state.context, 'passthrough-processor');
  }

  // 3. Подключаем новую цепочку.
  state.source.connect(newNode).connect(state.context.destination);
  state.node = newNode;
}
