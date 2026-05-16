/**
 * Real-time spectrogram waterfall на Canvas2D.
 * Привязывается к AnalyserNode, на каждый кадр rAF читает FFT bins,
 * рисует столбец справа, сдвигает изображение влево.
 */

const COLOR_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [10, 10, 20]],     // фон (тихо)
  [0.25, [40, 40, 100]],
  [0.5, [80, 130, 180]],
  [0.75, [220, 200, 80]],
  [1.0, [255, 90, 40]],    // громко
];

function colormap(v: number): [number, number, number] {
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t1, c1] = COLOR_STOPS[i];
    const [t0, c0] = COLOR_STOPS[i - 1];
    if (v <= t1) {
      const frac = (v - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * frac,
        c0[1] + (c1[1] - c0[1]) * frac,
        c0[2] + (c1[2] - c0[2]) * frac,
      ];
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1];
}

export class Spectrogram {
  private ctx: CanvasRenderingContext2D;
  private buf: Uint8Array;
  private rafId: number | null = null;
  private analyser: AnalyserNode | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.buf = new Uint8Array(0);
    this.clear();
  }

  attach(analyser: AnalyserNode): void {
    this.analyser = analyser;
    this.buf = new Uint8Array(analyser.frequencyBinCount);
    if (this.rafId === null) this.loop();
  }

  detach(): void {
    this.analyser = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clear();
  }

  private clear(): void {
    this.ctx.fillStyle = `rgb(${COLOR_STOPS[0][1].join(',')})`;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private loop = (): void => {
    if (!this.analyser) return;
    this.rafId = requestAnimationFrame(this.loop);

    this.analyser.getByteFrequencyData(this.buf);

    const W = this.canvas.width;
    const H = this.canvas.height;

    // Сдвигаем содержимое канваса на 1 px влево.
    const img = this.ctx.getImageData(1, 0, W - 1, H);
    this.ctx.putImageData(img, 0, 0);

    // Новый столбец справа: bins сверху=низкие, снизу=высокие частоты —
    // привычный «инвертированный по Y» спектрограмм-вид.
    const bins = this.buf.length;
    for (let y = 0; y < H; y++) {
      // log-spaced indexing — низкие частоты занимают больше места
      const t = y / H;
      const binIdx = Math.floor(bins * (1 - t) ** 2.2);
      const v = this.buf[Math.min(binIdx, bins - 1)] / 255;
      const [r, g, b] = colormap(v);
      this.ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      this.ctx.fillRect(W - 1, y, 1, 1);
    }
  };
}
