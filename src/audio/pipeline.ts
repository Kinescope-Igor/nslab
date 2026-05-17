/**
 * Аудио-pipeline с hot-swap между NS-режимами и поддержкой двух источников.
 *
 * Источники:
 *   mic  — MediaStreamAudioSourceNode (микрофон)
 *   file — AudioBufferSourceNode (loop) на готовом sample clip из public/clips/
 *
 * Режимы шумодава:
 *   raw     → 48 kHz AudioContext + passthrough worklet
 *   rnnoise → 48 kHz + forwarder worklet + RNNoise в main thread
 *   dtln    → 16 kHz + ScriptProcessorNode (TFLite DTLN)
 *   dfn3    → отключён (TODO: WASM trap, см. README)
 *
 * Так как RNNoise требует 48 kHz, а DTLN — 16 kHz, при смене режима
 * пересоздаём AudioContext с правильным sampleRate.
 *
 * Параллельно к destination звук уходит в analyser (для spectrogram) и в
 * recorderDest (MediaStreamAudioDestinationNode для записи через MediaRecorder).
 *
 * Все публичные операции сериализуются через opChain.
 */

import passthroughUrl from '../worklets/passthrough.js?url';
import forwarderUrl from '../worklets/forwarder.js?url';
import captureUrl from '../worklets/capture.js?url';
import * as rnnoise from './rnnoise';
import * as dtln from './dtln';
import * as dfn3 from './dfn3';
import * as gtcrn from './gtcrn';
import * as zipenhancer from './zipenhancer';

export type Mode = 'raw' | 'webrtc' | 'rnnoise' | 'dtln' | 'dfn3' | 'gtcrn' | 'zipenhancer';

export type SourceConfig =
  | { kind: 'mic' }
  | { kind: 'file'; url: string };

const SAMPLE_RATE: Record<Mode, number> = {
  raw: 48000,
  webrtc: 48000,
  rnnoise: 48000,
  dtln: 16000,
  dfn3: 48000,
  gtcrn: 16000,
  zipenhancer: 16000,
};

// WebRTC NS активируется через getUserMedia constraints (браузерный APM).
// Для готовых семплов недоступен — нет mic-pipeline, поэтому passthrough.
function micConstraintsFor(mode: Mode): MediaTrackConstraints {
  const isWebrtc = mode === 'webrtc';
  return {
    channelCount: 1,
    echoCancellation: isWebrtc,
    noiseSuppression: isWebrtc,
    autoGainControl: isWebrtc,
  };
}

export interface PipelineState {
  context: AudioContext | null;
  stream: MediaStream | null;
  source: AudioNode | null;
  node: AudioNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  recorderDest: MediaStreamAudioDestinationNode | null;
  capture: AudioWorkletNode | null;
  mode: Mode;
  sourceConfig: SourceConfig;
  gainValue: number;
  onRms?: (dbfs: number) => void;
  onVad?: (vad: number) => void;
}

export const state: PipelineState = {
  context: null,
  stream: null,
  source: null,
  node: null,
  gain: null,
  analyser: null,
  recorderDest: null,
  capture: null,
  mode: 'raw',
  sourceConfig: { kind: 'mic' },
  gainValue: 3, // +9.5 dB — типичная компенсация микрофона без AGC
};

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
    const prevMode = state.mode;
    state.mode = mode;
    if (!state.context) return;
    if (state.context.sampleRate !== SAMPLE_RATE[mode]) {
      await teardown();
      await reinitContext(mode);
      return;
    }
    // WebRTC NS живёт в mic-constraints — пересоздаём stream при переключении
    // в/из webrtc (если источник микрофон), иначе constraint не сменится.
    if (
      state.sourceConfig.kind === 'mic' &&
      (prevMode === 'webrtc') !== (mode === 'webrtc')
    ) {
      await reinitSource();
    }
    await applyMode(mode);
  });
}

export function setSource(cfg: SourceConfig): Promise<void> {
  return enqueue(async () => {
    state.sourceConfig = cfg;
    if (!state.context) return;
    await reinitSource();
  });
}

async function teardown(): Promise<void> {
  if (state.node && 'port' in state.node) {
    (state.node as AudioWorkletNode).port.onmessage = null;
  }
  state.node?.disconnect();
  // BufferSource нужно явно остановить, иначе ресурс висит в audio thread.
  if (state.source instanceof AudioBufferSourceNode) {
    try { state.source.stop(); } catch { /* already stopped */ }
  }
  state.source?.disconnect();
  state.analyser?.disconnect();
  state.recorderDest?.disconnect();
  if (state.capture) {
    state.capture.port.onmessage = null;
    state.capture.disconnect();
  }
  state.stream?.getTracks().forEach((t) => t.stop());
  state.gain?.disconnect();
  await state.context?.close();

  await Promise.all([
    rnnoise.destroy().catch(() => {}),
    dfn3.destroy().catch(() => {}),
    gtcrn.destroy().catch(() => {}),
    zipenhancer.destroy().catch(() => {}),
  ]);

  state.context = null;
  state.stream = null;
  state.source = null;
  state.node = null;
  state.gain = null;
  state.analyser = null;
  state.recorderDest = null;
  state.capture = null;
}

async function reinitContext(mode: Mode): Promise<void> {
  // Сначала источник — если getUserMedia denied / fetch упал, нет осиротевшего context.
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE[mode] });
    await context.audioWorklet.addModule(passthroughUrl);
    await context.audioWorklet.addModule(forwarderUrl);
  } catch (err) {
    throw err;
  }

  state.context = context;
  state.analyser = context.createAnalyser();
  state.analyser.fftSize = 1024;
  state.analyser.smoothingTimeConstant = 0.6;
  state.recorderDest = context.createMediaStreamDestination();
  state.gain = context.createGain();
  state.gain.gain.value = state.gainValue;

  await context.audioWorklet.addModule(captureUrl);
  state.capture = new AudioWorkletNode(context, 'capture-processor', {
    processorOptions: { sampleRate: context.sampleRate },
  });

  await reinitSource();
  await applyMode(mode);
}

async function reinitSource(): Promise<void> {
  if (!state.context) return;

  // Discard old source.
  if (state.source instanceof AudioBufferSourceNode) {
    try { state.source.stop(); } catch { /* */ }
  }
  state.source?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;

  if (state.sourceConfig.kind === 'mic') {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraintsFor(state.mode),
    });
    state.source = state.context.createMediaStreamSource(state.stream);
  } else {
    const arrayBuffer = await fetch(state.sourceConfig.url).then((r) => r.arrayBuffer());
    const audioBuffer = await state.context.decodeAudioData(arrayBuffer);
    const node = state.context.createBufferSource();
    node.buffer = audioBuffer;
    node.loop = true;
    node.start();
    state.source = node;
  }

  // Если node уже подключён — переподключим source к нему.
  if (state.node) {
    state.source.connect(state.node);
  }
}

async function applyMode(mode: Mode): Promise<void> {
  if (!state.context || !state.source || !state.analyser || !state.recorderDest || !state.capture) return;

  if (state.node) {
    if ('port' in state.node) {
      (state.node as AudioWorkletNode).port.onmessage = null;
    }
    if ('__markStale' in state.node) {
      (state.node as { __markStale?: () => void }).__markStale?.();
    }
  }
  state.source.disconnect();
  state.node?.disconnect();
  state.node = null;

  let newNode: AudioNode;

  if (mode === 'raw' || mode === 'webrtc') {
    // 'webrtc' = браузерный APM включён в mic-stream (см. micConstraintsFor),
    // здесь просто пропускаем уже-обработанный звук дальше.
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
    let isStale = false;
    (w as any).__markStale = () => { isStale = true; };
    w.port.onmessage = (e) => {
      if (isStale) return;
      if (e.data?.type === 'frame') {
        const frame = e.data.frame as Float32Array;
        const vad = rnnoise.processFrame(frame);
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
  } else if (mode === 'dfn3') {
    const loaded = await dfn3.init();
    const w = new AudioWorkletNode(state.context, 'forwarder-processor', {
      processorOptions: { frameSize: loaded.frameSize },
    });
    let pendingOut = new Float32Array(0);
    let isStale = false;
    (w as any).__markStale = () => { isStale = true; };
    w.port.onmessage = (e) => {
      if (isStale) return;
      if (e.data?.type === 'frame') {
        const frame = e.data.frame as Float32Array;
        const out = dfn3.processFrame(frame);
        if (out.length > 0) {
          const merged = new Float32Array(pendingOut.length + out.length);
          merged.set(pendingOut, 0);
          merged.set(out, pendingOut.length);
          pendingOut = merged;
        }
        if (pendingOut.length >= loaded.frameSize) {
          frame.set(pendingOut.subarray(0, loaded.frameSize));
          pendingOut = pendingOut.slice(loaded.frameSize);
        } else {
          frame.fill(0);
        }
        w.port.postMessage({ type: 'processed', frame }, [frame.buffer]);
        state.onVad?.(NaN);
      } else if (e.data?.type === 'rms') {
        state.onRms?.(e.data.dbfs);
      }
    };
    newNode = w;
  } else if (mode === 'gtcrn') {
    const loaded = await gtcrn.init();
    const w = new AudioWorkletNode(state.context, 'forwarder-processor', {
      processorOptions: { frameSize: loaded.frameSize },
    });
    let isStale = false;
    (w as any).__markStale = () => { isStale = true; };
    w.port.onmessage = (e) => {
      if (isStale) return;
      if (e.data?.type === 'frame') {
        const frame = e.data.frame as Float32Array;
        gtcrn.processFrameAsync(frame).then((out) => {
          if (isStale) return;
          // out — новый Float32Array, frame.buffer уже потерял свою копию;
          // отправляем out через transferable.
          w.port.postMessage({ type: 'processed', frame: out }, [out.buffer]);
        }).catch((err) => {
          console.error('gtcrn frame error', err);
        });
        state.onVad?.(NaN);
      } else if (e.data?.type === 'rms') {
        state.onRms?.(e.data.dbfs);
      }
    };
    newNode = w;
  } else if (mode === 'zipenhancer') {
    const loaded = await zipenhancer.init();
    const w = new AudioWorkletNode(state.context, 'forwarder-processor', {
      processorOptions: { frameSize: loaded.frameSize },
    });
    let isStale = false;
    (w as any).__markStale = () => { isStale = true; };
    w.port.onmessage = (e) => {
      if (isStale) return;
      if (e.data?.type === 'frame') {
        const frame = e.data.frame as Float32Array;
        zipenhancer.processChunkAsync(frame).then((out) => {
          if (isStale) return;
          w.port.postMessage({ type: 'processed', frame: out }, [out.buffer]);
        }).catch((err) => {
          console.error('zipenhancer chunk error', err);
        });
        state.onVad?.(NaN);
      } else if (e.data?.type === 'rms') {
        state.onRms?.(e.data.dbfs);
      }
    };
    newNode = w;
  } else {
    newNode = new AudioWorkletNode(state.context, 'passthrough-processor');
  }

  // Source → node → gain → {destination, analyser, recorderDest, capture}.
  // Gain нужен потому что raw-микрофон без AGC обычно тихий; пользователь
  // крутит его слайдером в UI. Усиление применяется ПОСЛЕ шумодава, чтобы
  // не насыщать вход модели и не сбивать VAD.
  state.source.connect(newNode);
  if (state.gain) {
    newNode.connect(state.gain);
    state.gain.connect(state.context.destination);
    state.gain.connect(state.analyser);
    state.gain.connect(state.recorderDest);
    state.gain.connect(state.capture);
  } else {
    newNode.connect(state.context.destination);
    newNode.connect(state.analyser);
    newNode.connect(state.recorderDest);
    newNode.connect(state.capture);
  }
  state.node = newNode;
}

export function setGain(value: number): void {
  state.gainValue = value;
  if (state.gain && state.context) {
    // Плавный ramp вместо мгновенного — без щелчка.
    state.gain.gain.setTargetAtTime(value, state.context.currentTime, 0.02);
  }
}
