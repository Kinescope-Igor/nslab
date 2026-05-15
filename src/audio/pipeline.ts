/**
 * Минимальный аудио-pipeline: mic → AudioWorkletNode → destination.
 * На текущем этапе используется только passthrough — проверка, что весь
 * каркас работает (microphone permission, AudioWorklet load, output не клипуется).
 *
 * Дальше сюда подключаются worklets для RNNoise / DTLN / DFN-3 с hot-swap.
 */

import passthroughUrl from '../worklets/passthrough.js?url';

export type Mode = 'raw' | 'rnnoise' | 'dtln' | 'dfn3';

export interface PipelineState {
  context: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  mode: Mode;
}

export const state: PipelineState = {
  context: null,
  stream: null,
  source: null,
  worklet: null,
  mode: 'raw',
};

export async function start(): Promise<void> {
  if (state.context) return;

  state.context = new AudioContext();

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Отключаем браузерный APM — мы хотим тестировать ИМЕННО наши шумодавы,
      // без подмеса WebRTC NS / AGC / AEC.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  await state.context.audioWorklet.addModule(passthroughUrl);
  state.source = state.context.createMediaStreamSource(state.stream);
  state.worklet = new AudioWorkletNode(state.context, 'passthrough-processor');

  state.source.connect(state.worklet).connect(state.context.destination);
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

export function setMode(mode: Mode): void {
  state.mode = mode;
  // TODO: hot-swap между worklets (raw / rnnoise / dtln / dfn3) — после подключения шумодавов.
}
