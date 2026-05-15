/**
 * Passthrough AudioWorklet — пропускает вход на выход без изменений.
 * Дублирует моно на все каналы output (наушники чаще стерео).
 * Заодно меряет RMS для индикатора уровня.
 */

class PassthroughProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frame = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!input || !output || output.length === 0) return true;

    // Копируем моно-вход на все каналы output (моно → стерео).
    const blockSize = output[0].length;
    for (let i = 0; i < blockSize; i++) {
      const sample = input[i] ?? 0;
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][i] = sample;
      }
    }

    // RMS каждые ~50 ms.
    this._frame++;
    if (this._frame % 5 === 0) {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const dbfs = 20 * Math.log10(Math.max(rms, 1e-10));
      this.port.postMessage({ type: 'rms', dbfs });
    }

    return true;
  }
}

registerProcessor('passthrough-processor', PassthroughProcessor);
