/**
 * GTCRN (Xiaobin-Rong/gtcrn, MIT) — ультралёгкий streaming-шумодав,
 * 23.67K параметров, 33 MMACs/s. Работает @ 16 kHz, n_fft=512, hop=256,
 * Hann^0.5 window. Один frame = один ONNX call.
 *
 * ONNX inputs:
 *   mix         (1, 257, 1, 2)  — complex STFT кадра
 *   conv_cache  (2, 1, 16, 16, 33)
 *   tra_cache   (2, 3, 1, 1, 16)
 *   inter_cache (2, 1, 33, 16)
 * outputs: enh + 3 обновлённых кэша. Между фреймами кэши carry'ятся.
 *
 * Обработка: classic STFT overlap-add. Каждый hop=256 → окно 512
 * (предыдущие 256 + новые 256), iSTFT даёт 512, OLA с прошлым tail-ом.
 * ort.run() async → processFrameAsync, вызывается из main thread,
 * не из audio worklet.
 */

import * as ort from 'onnxruntime-web';

const ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
const MODEL_URL = new URL('gtcrn/gtcrn_simple.onnx', document.baseURI).href;

const N_FFT = 512;
const HOP = 256;
const N_FREQ = N_FFT / 2 + 1;

// Hann^0.5 = sqrt(periodic Hann). Periodic (torch.hann_window default,
// делитель N а не N-1) даёт точный COLA=1 при hop=N/2 и одинаковом
// окне на analysis+synthesis. Автор: torch.stft(window=hann_window(N).pow(0.5)).
const WINDOW = (() => {
  const w = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
    w[n] = Math.sqrt(hann);
  }
  return w;
})();

// --- Radix-2 in-place FFT (Cooley-Tukey), N=512 -------------------------
function makeTwiddles(n: number) {
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return { cos, sin };
}
const TW = makeTwiddles(N_FFT);

function fft(re: Float32Array, im: Float32Array): void {
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
        const c = TW.cos[twIdx];
        const s = TW.sin[twIdx];
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

function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

// --- Loaded state ------------------------------------------------------

interface State {
  session: ort.InferenceSession;
  convCache: ort.Tensor;
  traCache: ort.Tensor;
  interCache: ort.Tensor;
  prevFrame: Float32Array;
  olaTail: Float32Array;
}

let loadedPromise: Promise<State> | null = null;

export interface Loaded {
  frameSize: number;
}

export async function init(): Promise<Loaded> {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      ort.env.wasm.wasmPaths = ORT_WASM_BASE;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;

      const buf = new Uint8Array(await (await fetch(MODEL_URL)).arrayBuffer());
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      return {
        session,
        convCache: new ort.Tensor('float32', new Float32Array(2 * 16 * 16 * 33), [2, 1, 16, 16, 33]),
        traCache: new ort.Tensor('float32', new Float32Array(2 * 3 * 16), [2, 3, 1, 1, 16]),
        interCache: new ort.Tensor('float32', new Float32Array(2 * 33 * 16), [2, 1, 33, 16]),
        prevFrame: new Float32Array(HOP),
        olaTail: new Float32Array(HOP),
      };
    })().catch((err) => {
      loadedPromise = null;
      throw err;
    });
  }
  await loadedPromise;
  return { frameSize: HOP };
}

/** Async: один hop=256 → enhanced 256. State carry внутри. */
export async function processFrameAsync(frame: Float32Array): Promise<Float32Array> {
  if (!loadedPromise) throw new Error('gtcrn not initialised');
  const st = await loadedPromise;

  if (frame.length !== HOP) {
    throw new Error(`gtcrn: ожидаем ${HOP} samples/frame, пришло ${frame.length}`);
  }

  // Аналитическое окно 512 = [prev, current]
  const windowed = new Float32Array(N_FFT);
  windowed.set(st.prevFrame, 0);
  windowed.set(frame, HOP);
  st.prevFrame = frame.slice();

  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) re[i] = windowed[i] * WINDOW[i];
  fft(re, im);

  // Pack 257 complex → (1, 257, 1, 2)
  const mixData = new Float32Array(N_FREQ * 2);
  for (let k = 0; k < N_FREQ; k++) {
    mixData[k * 2] = re[k];
    mixData[k * 2 + 1] = im[k];
  }
  const mix = new ort.Tensor('float32', mixData, [1, N_FREQ, 1, 2]);

  const outputs = await st.session.run({
    mix,
    conv_cache: st.convCache,
    tra_cache: st.traCache,
    inter_cache: st.interCache,
  });
  st.convCache = outputs.conv_cache_out as ort.Tensor;
  st.traCache = outputs.tra_cache_out as ort.Tensor;
  st.interCache = outputs.inter_cache_out as ort.Tensor;

  // Развернуть Hermitian 257 → 512 complex.
  const enhData = outputs.enh.data as Float32Array;
  const enhRe = new Float32Array(N_FFT);
  const enhIm = new Float32Array(N_FFT);
  for (let k = 0; k < N_FREQ; k++) {
    enhRe[k] = enhData[k * 2];
    enhIm[k] = enhData[k * 2 + 1];
  }
  for (let k = 1; k < N_FREQ - 1; k++) {
    enhRe[N_FFT - k] = enhRe[k];
    enhIm[N_FFT - k] = -enhIm[k];
  }
  ifft(enhRe, enhIm);

  // Synthesis window + OLA: out[i] = olaTail[i] + (synth[i]); tail = synth[256..511]
  const out = new Float32Array(HOP);
  for (let i = 0; i < HOP; i++) {
    out[i] = st.olaTail[i] + enhRe[i] * WINDOW[i];
  }
  for (let i = 0; i < HOP; i++) {
    st.olaTail[i] = enhRe[HOP + i] * WINDOW[HOP + i];
  }
  return out;
}

export async function destroy(): Promise<void> {
  if (loadedPromise) {
    const st = await loadedPromise.catch(() => null);
    await st?.session?.release().catch(() => {});
    loadedPromise = null;
  }
}
