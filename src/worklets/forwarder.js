/**
 * Forwarder worklet: ring-buffer на frameSize семплов.
 * Шлёт собранный фрейм в main thread через port, ждёт обратно обработанный
 * и пишет его в output. Если обработанный фрейм ещё не пришёл — output silence.
 *
 * Используется для всех NS-режимов (RNNoise / DTLN / DFN-3): сама модель
 * крутится в main thread, worklet — только транспорт.
 */

class Forwarder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions?.frameSize ?? 480;
    this.inputBuf = new Float32Array(this.frameSize);
    this.inputPos = 0;
    this.outputQueue = []; // массивы Float32Array(frameSize) обработанных фреймов
    this.outputBuf = null;
    this.outputPos = 0;
    this.frameId = 0;
    this.rmsTick = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === 'processed') {
        this.outputQueue.push(e.data.frame);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    // 1. Складываем входные семплы в inputBuf, при заполнении — отправляем фрейм.
    for (let i = 0; i < input.length; i++) {
      this.inputBuf[this.inputPos++] = input[i];
      if (this.inputPos === this.frameSize) {
        // Передаём через transferable для нулевой копии.
        const frame = this.inputBuf;
        this.inputBuf = new Float32Array(this.frameSize);
        this.inputPos = 0;
        this.port.postMessage(
          { type: 'frame', id: this.frameId++, frame },
          [frame.buffer]
        );
      }
    }

    // 2. Заполняем output из outputQueue.
    for (let i = 0; i < output.length; i++) {
      if (!this.outputBuf || this.outputPos >= this.outputBuf.length) {
        this.outputBuf = this.outputQueue.shift() ?? null;
        this.outputPos = 0;
      }
      output[i] = this.outputBuf ? this.outputBuf[this.outputPos++] : 0;
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
