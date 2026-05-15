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

export async function start(): Promise<void> {
  if (state.context) return;
  await reinitContext(state.mode);
}

export async function stop(): Promise<void> {
  state.node?.disconnect();
  state.source?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  await state.context?.close();

  state.context = null;
  state.stream = null;
  state.source = null;
  state.node = null;
}

export async function setMode(mode: Mode): Promise<void> {
  const wasRunning = !!state.context;
  state.mode = mode;
  if (!wasRunning) return;

  // Если sample rate не меняется — переключаем только обработчик.
  if (state.context!.sampleRate === SAMPLE_RATE[mode]) {
    await applyMode(mode);
  } else {
    // Иначе — пересоздаём context.
    await stop();
    await reinitContext(mode);
  }
}

async function reinitContext(mode: Mode): Promise<void> {
  state.context = new AudioContext({ sampleRate: SAMPLE_RATE[mode] });

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Отключаем браузерный APM — мы тестируем ИМЕННО наши шумодавы.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  await state.context.audioWorklet.addModule(passthroughUrl);
  await state.context.audioWorklet.addModule(forwarderUrl);

  state.source = state.context.createMediaStreamSource(state.stream);
  await applyMode(mode);
}

async function applyMode(mode: Mode): Promise<void> {
  if (!state.context || !state.source) return;

  const oldNode = state.node;
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
    state.onVad?.(NaN); // у DTLN VAD нет
  } else {
    // dfn3 — TODO
    newNode = new AudioWorkletNode(state.context, 'passthrough-processor');
  }

  state.source.connect(newNode).connect(state.context.destination);
  oldNode?.disconnect();
  state.node = newNode;
}
