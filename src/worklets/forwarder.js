/**
 * Forwarder worklet: ring-buffer на frameSize семплов.
 * Шлёт собранный фрейм в main thread через port, ждёт обратно обработанный.
 *
 * Pre-roll: при старте кладём в outputQueue несколько silence-фреймов, чтобы
 * дать main thread фору. Без этого первые ~50 ms будет underrun → клик/треск.
 *
 * Output дублируется на все каналы (микрофон моно, наушники стерео).
 *
 * Pool: вместо `new Float32Array(frameSize)` на каждые 10 ms используем пул
 * буферов. Buffer уходит main-thread'у через transferable, после processFrame
 * возвращается в outputQueue → реюз через pool.acquire(). Снимает ~100/сек
 * аллокаций → меньше GC pause.
 */

// Эксперименты A+B: drop-old → bound выше, pre-roll → 1 (минимум для buffer).
// Чтобы убрать «булькающий» / прерывистый звук на готовых семплах.
const PRE_ROLL_FRAMES = 1;       // было 4 → 40 ms лишней задержки + возможное «сжатие» речи
const MAX_QUEUE_FRAMES = 30;     // было 12 → агрессивный drop при минимальном jitter; теперь только аварийный
const POOL_SIZE = 32;            // pool под обновлённый MAX

class Forwarder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions?.frameSize ?? 480;

    // Pool: pre-allocate POOL_SIZE буферов, реюзаем по acquire/release.
    this._pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this._pool.push(new Float32Array(this.frameSize));
    }

    this.inputBuf = this._pool.pop() ?? new Float32Array(this.frameSize);
    this.inputPos = 0;
    this.outputQueue = [];
    this.outputBuf = null;
    this.outputPos = 0;
    this.frameId = 0;
    this.rmsTick = 0;

    // Pre-roll: silence-фреймы, чтобы output не пустовал в первые несколько вызовов process().
    for (let i = 0; i < PRE_ROLL_FRAMES; i++) {
      this.outputQueue.push(new Float32Array(this.frameSize));
    }

    this.port.onmessage = (e) => {
      if (e.data?.type === 'processed') {
        this.outputQueue.push(e.data.frame);
        // Drop-old: если main thread медленнее реального времени, очередь
        // растёт неограниченно (память + латентность). Сбрасываем самые
        // старые, оставляя свежие — пользователь слышит «прыжок» вместо
        // нарастающей задержки.
        while (this.outputQueue.length > MAX_QUEUE_FRAMES) {
          const dropped = this.outputQueue.shift();
          this._release(dropped);
        }
      }
    };
  }

  _acquire() {
    return this._pool.pop() ?? new Float32Array(this.frameSize);
  }

  _release(buf) {
    if (buf && buf.length === this.frameSize && this._pool.length < POOL_SIZE) {
      // ArrayBuffer мог быть detach'нут transferable — проверяем.
      if (buf.buffer.byteLength === this.frameSize * 4) {
        this._pool.push(buf);
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]; // массив каналов (1 или 2 для стерео-устройств)
    if (!input || !output || output.length === 0) return true;

    const blockSize = output[0].length;

    // 1. Складываем входные семплы, при заполнении — отправляем фрейм.
    for (let i = 0; i < input.length; i++) {
      this.inputBuf[this.inputPos++] = input[i];
      if (this.inputPos === this.frameSize) {
        const frame = this.inputBuf;
        this.inputBuf = this._acquire();
        this.inputPos = 0;
        this.port.postMessage(
          { type: 'frame', id: this.frameId++, frame },
          [frame.buffer]
        );
      }
    }

    // 2. Заполняем output из outputQueue, дублируем на все каналы (моно → стерео).
    for (let i = 0; i < blockSize; i++) {
      if (!this.outputBuf || this.outputPos >= this.outputBuf.length) {
        this._release(this.outputBuf);
        this.outputBuf = this.outputQueue.shift() ?? null;
        this.outputPos = 0;
      }
      const sample = this.outputBuf ? this.outputBuf[this.outputPos++] : 0;
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][i] = sample;
      }
    }

    // 3. RMS на input каждые ~50 ms.
    if (++this.rmsTick % 5 === 0) {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const dbfs = 20 * Math.log10(Math.max(rms, 1e-10));
      this.port.postMessage({ type: 'rms', dbfs });
    }

    return true;
  }
}

registerProcessor('forwarder-processor', Forwarder);
