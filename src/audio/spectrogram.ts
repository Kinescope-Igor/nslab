/**
 * Real-time spectrogram waterfall на Canvas2D.
 *
 * Производительность: держим один ImageData-buffer (W×H), shift влево через
 * Uint8ClampedArray.set (быстрая копия памяти), новая колонка пишется напрямую
 * в .data, итог отдаётся одним putImageData. На каждый кадр:
 *   - 1 чтение из AnalyserNode
 *   - 1 memmove на ~400 KB
 *   - 1 putImageData
 * Без getImageData (raw pixel readback из GPU) и без N fillRect.
 *
 * Дополнительно: рендерим только каждый 2-й RAF (~30 fps вместо 60) — на ухо
 * waterfall неотличим, CPU/GPU делим пополам.
 */

const COLOR_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [10, 10, 20]],
  [0.25, [40, 40, 100]],
  [0.5, [80, 130, 180]],
  [0.75, [220, 200, 80]],
  [1.0, [255, 90, 40]],
];

// Pre-bake LUT на 256 значений: индекс = байт из getByteFrequencyData,
// результат = [r, g, b] — убираем интерполяцию из hot-loop.
const LUT_R = new Uint8Array(256);
const LUT_G = new Uint8Array(256);
const LUT_B = new Uint8Array(256);
(function buildLut() {
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let [r, g, b]: [number, number, number] = [0, 0, 0];
    for (let s = 1; s < COLOR_STOPS.length; s++) {
      const [t1, c1] = COLOR_STOPS[s];
      const [t0, c0] = COLOR_STOPS[s - 1];
      if (v <= t1) {
        const frac = (v - t0) / (t1 - t0);
        r = c0[0] + (c1[0] - c0[0]) * frac;
        g = c0[1] + (c1[1] - c0[1]) * frac;
        b = c0[2] + (c1[2] - c0[2]) * frac;
        break;
      }
    }
    LUT_R[i] = r | 0;
    LUT_G[i] = g | 0;
    LUT_B[i] = b | 0;
  }
})();

export class Spectrogram {
  private ctx: CanvasRenderingContext2D;
  private freqBuf: Uint8Array;
  private imgData: ImageData;
  private W: number;
  private H: number;
  private binIdxByY: Int32Array; // pre-computed log-mapping y → bin index
  private rafId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private frameToggle = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.W = canvas.width;
    this.H = canvas.height;
    this.freqBuf = new Uint8Array(0);
    this.imgData = ctx.createImageData(this.W, this.H);
    this.binIdxByY = new Int32Array(this.H);
    this.fillSolid(COLOR_STOPS[0][1]);
  }

  attach(analyser: AnalyserNode): void {
    this.analyser = analyser;
    this.freqBuf = new Uint8Array(analyser.frequencyBinCount);

    // Фиксируем верхнюю границу спектрограммы на 8 kHz, чтобы все режимы
    // (16k DTLN/GTCRN и 48k RNNoise/DFN-3) показывали один и тот же
    // частотный диапазон. Иначе 48k-модели «выглядят порезанными» —
    // основная энергия речи (80 Hz - 6 kHz) занимает только верхнюю
    // треть, а нижние 2/3 (6-24 kHz) почти пустые. На самом деле модель
    // не режет ничего, просто там нет содержания.
    const nyquist = analyser.context.sampleRate / 2;
    const maxHz = Math.min(8000, nyquist);
    const maxBin = Math.max(1, Math.floor((maxHz / nyquist) * analyser.frequencyBinCount));

    // Pre-compute log-spaced индексы (низкие сверху, высокие снизу), до maxBin.
    for (let y = 0; y < this.H; y++) {
      const t = y / this.H;
      const idx = Math.floor(maxBin * (1 - t) ** 2.2);
      this.binIdxByY[y] = Math.min(idx, maxBin - 1);
    }
    if (this.rafId === null) this.loop();
  }

  detach(): void {
    this.analyser = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.fillSolid(COLOR_STOPS[0][1]);
  }

  private fillSolid([r, g, b]: [number, number, number]): void {
    const data = this.imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    this.ctx.putImageData(this.imgData, 0, 0);
  }

  private loop = (): void => {
    if (!this.analyser) return;
    this.rafId = requestAnimationFrame(this.loop);

    // Render only every 2nd frame (~30 fps) — waterfall на ухо то же,
    // CPU/GPU делим пополам.
    if ((this.frameToggle++ & 1) !== 0) return;

    this.analyser.getByteFrequencyData(this.freqBuf);

    const W = this.W;
    const H = this.H;
    const data = this.imgData.data;
    const rowStride = W * 4;

    // 1. Shift всей картинки влево на 1 px через memmove внутри Uint8ClampedArray.
    //    set(src, offset) — оптимизированная копия в V8 (мемcpy).
    for (let y = 0; y < H; y++) {
      const rowStart = y * rowStride;
      // Копируем биты [1..W) → [0..W-1).
      data.copyWithin(rowStart, rowStart + 4, rowStart + rowStride);
    }

    // 2. Заполняем последнюю колонку (x = W - 1) новыми данными.
    const lastColOffset = (W - 1) * 4;
    for (let y = 0; y < H; y++) {
      const v = this.freqBuf[this.binIdxByY[y]];
      const off = y * rowStride + lastColOffset;
      data[off] = LUT_R[v];
      data[off + 1] = LUT_G[v];
      data[off + 2] = LUT_B[v];
      data[off + 3] = 255;
    }

    // 3. Одна команда отрисовки.
    this.ctx.putImageData(this.imgData, 0, 0);
  };
}
