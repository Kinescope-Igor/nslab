/**
 * DPDFNet (ceva-ip/DPDFNet, Apache-2.0) — DeepFilterNet2 + Dual-Path RNN.
 * Streaming, causal speech enhancement. https://arxiv.org/abs/2512.16420
 *
 * Two variants:
 *   - 16k: sr=16000, n_fft=320, hop=160, freq_bins=161, state=45424
 *   - 48k: sr=48000, n_fft=960, hop=480, freq_bins=481, state=56436
 *
 * ONNX I/O per frame:
 *   inputs:  spec(1,1,F,2) + state_in(state_size,)
 *   outputs: spec_e(1,1,F,2) + state_out(state_size,)
 *
 * STFT: vorbis window (Princen-Bradley). n_fft=320/960 are NOT power of 2,
 * so we use Bluestein's chirp-z transform built on a radix-2 FFT of size
 * M = next_pow2(2N-1).
 *
 * Initial state pulled from ONNX `customMetadataMap` (erb_norm_init,
 * spec_norm_init CSV).
 */

import * as ort from 'onnxruntime-web';

const ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
(ort.env as unknown as { wasm: { wasmPaths: string } }).wasm.wasmPaths = ORT_WASM_BASE;

export type Variant = '16k' | '48k';

interface ModelConfig {
  url: string;
  sampleRate: number;
  nFft: number;
  hop: number;
  freqBins: number;
  stateSize: number;
  erbNormSize: number;
  spectNormSize: number;
}

const VARIANTS: Record<Variant, ModelConfig> = {
  '16k': {
    url: new URL('dpdfnet/dpdfnet2.onnx', document.baseURI).href,
    sampleRate: 16000,
    nFft: 320,
    hop: 160,
    freqBins: 161,
    stateSize: 45424,
    erbNormSize: 32,
    spectNormSize: 96,
  },
  '48k': {
    url: new URL('dpdfnet/dpdfnet2_48khz_hr.onnx', document.baseURI).href,
    sampleRate: 48000,
    nFft: 960,
    hop: 480,
    freqBins: 481,
    stateSize: 56436,
    erbNormSize: 481,
    spectNormSize: 96,
  },
};

// --- Vorbis window (Princen-Bradley: w[n]² + w[n+N/2]² = 1) -----------
function vorbisWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  const half = n / 2;
  for (let i = 0; i < n; i++) {
    const s = Math.sin((0.5 * Math.PI * (i + 0.5)) / half);
    w[i] = Math.sin(0.5 * Math.PI * s * s);
  }
  return w;
}

// --- Radix-2 FFT helpers --------------------------------------------------
interface Twiddles { cos: Float32Array; sin: Float32Array; }
function makeTwiddles(n: number): Twiddles {
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return { cos, sin };
}
function fft2(re: Float32Array, im: Float32Array, tw: Twiddles): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0, twIdx = 0; k < half; k++, twIdx += step) {
        const c = tw.cos[twIdx];
        const s = tw.sin[twIdx];
        const tre = re[i + k + half] * c - im[i + k + half] * s;
        const tim = re[i + k + half] * s + im[i + k + half] * c;
        re[i + k + half] = re[i + k] - tre;
        im[i + k + half] = im[i + k] - tim;
        re[i + k] += tre;
        im[i + k] += tim;
      }
    }
  }
}
function ifft2(re: Float32Array, im: Float32Array, tw: Twiddles): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft2(re, im, tw);
  const scale = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= scale;
    im[i] = -im[i] * scale;
  }
}

// --- Bluestein chirp-Z transform for arbitrary N --------------------------
function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }
interface BluesteinPlan {
  N: number;
  M: number;
  twM: Twiddles;
  chirpRe: Float32Array; chirpIm: Float32Array;
  filterRe: Float32Array; filterIm: Float32Array;
}
function makeBluesteinPlan(N: number): BluesteinPlan {
  const M = nextPow2(2 * N - 1);
  const twM = makeTwiddles(M);
  const chirpRe = new Float32Array(N);
  const chirpIm = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const k = (n * n) % (2 * N);
    const angle = (-Math.PI * k) / N;
    chirpRe[n] = Math.cos(angle);
    chirpIm[n] = Math.sin(angle);
  }
  const filterRe = new Float32Array(M);
  const filterIm = new Float32Array(M);
  filterRe[0] = chirpRe[0]; filterIm[0] = -chirpIm[0];
  for (let n = 1; n < N; n++) {
    filterRe[n] = chirpRe[n]; filterIm[n] = -chirpIm[n];
    filterRe[M - n] = chirpRe[n]; filterIm[M - n] = -chirpIm[n];
  }
  fft2(filterRe, filterIm, twM);
  return { N, M, twM, chirpRe, chirpIm, filterRe, filterIm };
}
function bluesteinFFT(
  inRe: Float32Array, inIm: Float32Array,
  outRe: Float32Array, outIm: Float32Array,
  plan: BluesteinPlan, scratch: { aRe: Float32Array; aIm: Float32Array },
): void {
  const { N, M, twM, chirpRe, chirpIm, filterRe, filterIm } = plan;
  const aRe = scratch.aRe;
  const aIm = scratch.aIm;
  aRe.fill(0); aIm.fill(0);
  for (let n = 0; n < N; n++) {
    aRe[n] = inRe[n] * chirpRe[n] - inIm[n] * chirpIm[n];
    aIm[n] = inRe[n] * chirpIm[n] + inIm[n] * chirpRe[n];
  }
  fft2(aRe, aIm, twM);
  for (let k = 0; k < M; k++) {
    const ar = aRe[k], ai = aIm[k], br = filterRe[k], bi = filterIm[k];
    aRe[k] = ar * br - ai * bi;
    aIm[k] = ar * bi + ai * br;
  }
  ifft2(aRe, aIm, twM);
  for (let n = 0; n < N; n++) {
    outRe[n] = aRe[n] * chirpRe[n] - aIm[n] * chirpIm[n];
    outIm[n] = aRe[n] * chirpIm[n] + aIm[n] * chirpRe[n];
  }
}
function bluesteinIFFT(
  inRe: Float32Array, inIm: Float32Array,
  outRe: Float32Array, outIm: Float32Array,
  plan: BluesteinPlan, scratch: { aRe: Float32Array; aIm: Float32Array },
): void {
  const N = plan.N;
  const negIm = new Float32Array(N);
  for (let i = 0; i < N; i++) negIm[i] = -inIm[i];
  bluesteinFFT(inRe, negIm, outRe, outIm, plan, scratch);
  const s = 1 / N;
  for (let i = 0; i < N; i++) {
    outRe[i] *= s;
    outIm[i] = -outIm[i] * s;
  }
}

// --- Engine state per variant ---------------------------------------------
interface State {
  session: ort.InferenceSession;
  cfg: ModelConfig;
  window: Float32Array;
  fftPlan: BluesteinPlan;
  initialState: Float32Array;
  state: Float32Array;
  inputRing: Float32Array;
  prevTail: Float32Array;
  // reusable scratch buffers
  scratch: { aRe: Float32Array; aIm: Float32Array };
  frameRe: Float32Array; frameIm: Float32Array;
  specRe: Float32Array; specIm: Float32Array;
  enhRe: Float32Array; enhIm: Float32Array;
  ifftRe: Float32Array; ifftIm: Float32Array;
}

const loadedPromises: Partial<Record<Variant, Promise<State>>> = {};

async function buildState(variant: Variant): Promise<State> {
  const cfg = VARIANTS[variant];
  const session = await ort.InferenceSession.create(cfg.url, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  // initial state from ONNX customMetadataMap
  let erbInit: number[] = [];
  let spectInit: number[] = [];
  const mdAccessor = session as unknown as { modelMetadata?: { customMetadataMap?: Record<string, string> } };
  const mdMap = mdAccessor.modelMetadata?.customMetadataMap;
  if (mdMap?.erb_norm_init) erbInit = mdMap.erb_norm_init.split(',').map((s) => parseFloat(s));
  if (mdMap?.spec_norm_init) spectInit = mdMap.spec_norm_init.split(',').map((s) => parseFloat(s));

  const initialState = new Float32Array(cfg.stateSize);
  for (let i = 0; i < Math.min(erbInit.length, cfg.erbNormSize); i++) initialState[i] = erbInit[i];
  for (let i = 0; i < Math.min(spectInit.length, cfg.spectNormSize); i++) initialState[cfg.erbNormSize + i] = spectInit[i];

  const fftPlan = makeBluesteinPlan(cfg.nFft);
  return {
    session,
    cfg,
    window: vorbisWindow(cfg.nFft),
    fftPlan,
    initialState,
    state: new Float32Array(initialState),
    inputRing: new Float32Array(cfg.nFft),
    prevTail: new Float32Array(cfg.nFft),
    scratch: { aRe: new Float32Array(fftPlan.M), aIm: new Float32Array(fftPlan.M) },
    frameRe: new Float32Array(cfg.nFft),
    frameIm: new Float32Array(cfg.nFft),
    specRe: new Float32Array(cfg.nFft),
    specIm: new Float32Array(cfg.nFft),
    enhRe: new Float32Array(cfg.nFft),
    enhIm: new Float32Array(cfg.nFft),
    ifftRe: new Float32Array(cfg.nFft),
    ifftIm: new Float32Array(cfg.nFft),
  };
}

export async function init(variant: Variant = '48k'): Promise<{ sampleRate: number; hop: number; frameSize: number }> {
  if (!loadedPromises[variant]) loadedPromises[variant] = buildState(variant);
  const st = await loadedPromises[variant]!;
  // reset stream state on each fresh init
  st.state.set(st.initialState);
  st.inputRing.fill(0);
  st.prevTail.fill(0);
  return { sampleRate: st.cfg.sampleRate, hop: st.cfg.hop, frameSize: st.cfg.hop };
}

async function processWithState(st: State, frame: Float32Array): Promise<Float32Array> {
  const { cfg, window, fftPlan, scratch } = st;
  const N = cfg.nFft;
  const H = cfg.hop;
  const F = cfg.freqBins;
  if (frame.length !== H) throw new Error(`DPDFNet: expected hop=${H}, got ${frame.length}`);

  // slide input ring: keep last (N-H), append new H
  st.inputRing.copyWithin(0, H, N);
  st.inputRing.set(frame, N - H);

  // window + FFT
  for (let i = 0; i < N; i++) {
    st.frameRe[i] = st.inputRing[i] * window[i];
    st.frameIm[i] = 0;
  }
  bluesteinFFT(st.frameRe, st.frameIm, st.specRe, st.specIm, fftPlan, scratch);

  // pack tensor (1,1,F,2)
  const specTensorData = new Float32Array(F * 2);
  for (let f = 0; f < F; f++) {
    specTensorData[f * 2] = st.specRe[f];
    specTensorData[f * 2 + 1] = st.specIm[f];
  }
  const specTensor = new ort.Tensor('float32', specTensorData, [1, 1, F, 2]);
  const stateTensor = new ort.Tensor('float32', st.state.slice(), [cfg.stateSize]);

  const outs = await st.session.run({ spec: specTensor, state_in: stateTensor });
  const enhData = outs.spec_e.data as Float32Array;
  const newState = outs.state_out.data as Float32Array;
  st.state.set(newState);

  // unpack + Hermitian symmetry for real iSTFT
  st.enhRe.fill(0);
  st.enhIm.fill(0);
  for (let f = 0; f < F; f++) {
    st.enhRe[f] = enhData[f * 2];
    st.enhIm[f] = enhData[f * 2 + 1];
  }
  for (let f = 1; f < F - 1; f++) {
    st.enhRe[N - f] = st.enhRe[f];
    st.enhIm[N - f] = -st.enhIm[f];
  }

  bluesteinIFFT(st.enhRe, st.enhIm, st.ifftRe, st.ifftIm, fftPlan, scratch);

  // synthesis window + OLA
  for (let i = 0; i < N; i++) st.ifftRe[i] *= window[i];
  const out = new Float32Array(H);
  for (let i = 0; i < H; i++) out[i] = st.ifftRe[i] + st.prevTail[i];
  // new tail = current ifft[H..N] OLAed with shifted prevTail
  const newTail = new Float32Array(N);
  for (let i = 0; i < N - H; i++) newTail[i] = st.ifftRe[H + i] + st.prevTail[H + i];
  st.prevTail.set(newTail);
  return out;
}

export async function processFrameAsync(frame: Float32Array, variant: Variant = '48k'): Promise<Float32Array> {
  const p = loadedPromises[variant];
  if (!p) throw new Error(`dpdfnet: variant '${variant}' not initialised`);
  const st = await p;
  return processWithState(st, frame);
}

export async function destroy(): Promise<void> {
  for (const v of Object.keys(loadedPromises) as Variant[]) {
    const p = loadedPromises[v];
    if (!p) continue;
    const st = await p.catch(() => null);
    await st?.session?.release().catch(() => {});
    delete loadedPromises[v];
  }
}
