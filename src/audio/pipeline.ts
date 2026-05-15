/**
 * Аудио-pipeline с hot-swap между NS-режимами.
 *
 * raw         → passthrough worklet (нулевая обработка, low latency)
 * rnnoise     → forwarder worklet + RNNoise в main thread
 * dtln / dfn3 → forwarder worklet + соответствующий host (TODO)
 */

import passthroughUrl from '../worklets/passthrough.js?url';
import forwarderUrl from '../worklets/forwarder.js?url';
import * as rnnoise from './rnnoise';

export type Mode = 'raw' | 'rnnoise' | 'dtln' | 'dfn3';

export interface PipelineState {
  context: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  mode: Mode;
  onRms?: (dbfs: number) => void;
  onVad?: (vad: number) => void;
}

export const state: PipelineState = {
  context: null,
  stream: null,
  source: null,
  worklet: null,
  mode: 'raw',
};

let modulesLoaded = false;

export async function start(): Promise<void> {
  if (state.context) return;

  state.context = new AudioContext();

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Отключаем браузерный APM — мы тестируем ИМЕННО наши шумодавы.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  if (!modulesLoaded) {
    await state.context.audioWorklet.addModule(passthroughUrl);
    await state.context.audioWorklet.addModule(forwarderUrl);
    modulesLoaded = true;
  }

  state.source = state.context.createMediaStreamSource(state.stream);
  await applyMode(state.mode);
}

export async function stop(): Promise<void> {
  state.worklet?.disconnect();
  state.source?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  await state.context?.close();

  state.context = null;
  state.stream = null;
  state.source = null;
  state.worklet = null;
}

export async function setMode(mode: Mode): Promise<void> {
  state.mode = mode;
  if (state.context && state.source) {
    await applyMode(mode);
  }
}

/** Создаёт worklet под выбранный режим, отключает старый, подключает новый. */
async function applyMode(mode: Mode): Promise<void> {
  if (!state.context || !state.source) return;

  const oldWorklet = state.worklet;

  let newWorklet: AudioWorkletNode;

  if (mode === 'raw') {
    newWorklet = new AudioWorkletNode(state.context, 'passthrough-processor');
  } else if (mode === 'rnnoise') {
    const loaded = await rnnoise.init();
    newWorklet = new AudioWorkletNode(state.context, 'forwarder-processor', {
      processorOptions: { frameSize: loaded.frameSize },
    });
    newWorklet.port.onmessage = async (e) => {
      if (e.data?.type === 'frame') {
        const frame = e.data.frame as Float32Array;
        const vad = await rnnoise.processFrame(frame);
        newWorklet.port.postMessage({ type: 'processed', frame }, [frame.buffer]);
        state.onVad?.(vad);
      } else if (e.data?.type === 'rms') {
        state.onRms?.(e.data.dbfs);
      }
    };
  } else {
    // dtln / dfn3 — TODO
    newWorklet = new AudioWorkletNode(state.context, 'passthrough-processor');
  }

  // Подвязываем RMS-канал для passthrough.
  if (mode === 'raw') {
    newWorklet.port.onmessage = (e) => {
      if (e.data?.type === 'rms') state.onRms?.(e.data.dbfs);
    };
  }

  state.source.connect(newWorklet).connect(state.context.destination);
  oldWorklet?.disconnect();
  state.worklet = newWorklet;
}
