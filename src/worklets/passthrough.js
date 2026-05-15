/**
 * Passthrough AudioWorklet — пропускает вход на выход без изменений.
 * Заодно меряет RMS для индикатора уровня.
 *
 * Дальнейшие worklets (rnnoise/dtln/dfn3) построены по тому же шаблону:
 * — в process() копируется input → output, опционально через NS-обработчик;
 * — RMS отправляется в main thread через port.postMessage().
 */

class PassthroughProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frame = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    // Копируем все каналы.
    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!inCh) continue;
      for (let i = 0; i < outCh.length; i++) {
        outCh[i] = inCh[i];
      }
    }

    // Считаем RMS первого канала, шлём в main thread каждые ~50 ms.
    this._frame++;
    if (this._frame % 5 === 0 && input[0]) {
      const ch0 = input[0];
      let sum = 0;
      for (let i = 0; i < ch0.length; i++) sum += ch0[i] * ch0[i];
      const rms = Math.sqrt(sum / ch0.length);
      const dbfs = 20 * Math.log10(Math.max(rms, 1e-10));
      this.port.postMessage({ type: 'rms', dbfs });
    }

    return true;
  }
}

registerProcessor('passthrough-processor', PassthroughProcessor);
