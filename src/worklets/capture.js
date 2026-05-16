/**
 * Capture worklet — passthrough + ring-buffer на N секунд.
 * Шлёт snapshot буфера в main по запросу (port message {type:'snapshot'}).
 *
 * Используется для DNSMOS-инференса: main thread раз в ~3 sec
 * запрашивает последние 9 sec обработанного звука.
 */

const HISTORY_SEC = 12; // запас над 9 sec для DNSMOS
const TICK_MOD = 50;    // лёгкий лог-реже

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = options.processorOptions?.sampleRate ?? sampleRate;
    this.sr = sr;
    this.size = sr * HISTORY_SEC;
    this.buf = new Float32Array(this.size);
    this.pos = 0;
    this.tick = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === 'snapshot') {
        // Возвращаем ring buffer в правильном порядке: самое старое → новое.
        const out = new Float32Array(this.size);
        out.set(this.buf.subarray(this.pos), 0);
        out.set(this.buf.subarray(0, this.pos), this.size - this.pos);
        this.port.postMessage({ type: 'snapshot', samples: out, sampleRate: this.sr }, [out.buffer]);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!input || !output) return true;

    // Passthrough на все каналы output.
    const blockSize = output[0].length;
    for (let i = 0; i < blockSize; i++) {
      const sample = input[i] ?? 0;
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][i] = sample;
      }
    }

    // Запись в ring buffer.
    for (let i = 0; i < input.length; i++) {
      this.buf[this.pos++] = input[i];
      if (this.pos >= this.size) this.pos = 0;
    }

    this.tick++;
    return true;
  }
}

registerProcessor('capture-processor', Capture);
