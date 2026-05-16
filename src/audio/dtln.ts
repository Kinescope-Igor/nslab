/**
 * DTLN-rs wrapper через @sapphi-red/dtln-web (TFLite-runtime).
 *
 * Особенности:
 *  - sample rate 16 kHz (фиксировано моделью DTLN)
 *  - использует ScriptProcessorNode (deprecated, но работает в браузерах)
 *  - модель и tflite-runtime копируются в public/dtln-web/
 *
 * Lazy-init: библиотека грузится при первом setMode('dtln') через dynamic import.
 */

interface DtlnApi {
  sampleRate: number;
  createNode: (ctx: BaseAudioContext) => ScriptProcessorNode;
}

let apiPromise: Promise<DtlnApi> | null = null;

export async function init(): Promise<DtlnApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      // Hack: tflite-runtime внутри dtln-web автоматически выбирает
      // _simd_threaded.js при наличии SharedArrayBuffer (мы включили
      // COOP/COEP для DFN-3). Threaded XNNPACK затем спавнит worker
      // thread'ы → main-thread ScriptProcessorNode (через который dtln-web
      // обрабатывает аудио) голодает → tab вешается.
      //
      // Перехватываем WebAssembly.Memory({shared:true}) на время setup() —
      // isSupportedMultiThreaded() кинет → tflite выберет cc_simd.js
      // (non-threaded SIMD) → всё в одном main-thread без worker-конфликта.
      const origMemory = WebAssembly.Memory;
      (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = function (
        opts: WebAssembly.MemoryDescriptor,
      ) {
        if (opts && (opts as { shared?: boolean }).shared) {
          throw new Error('shared WASM memory disabled (DTLN starvation workaround)');
        }
        return new origMemory(opts);
      } as unknown as typeof WebAssembly.Memory;

      try {
        const m = await import('@sapphi-red/dtln-web');
        await m.setup('/dtln-web/');
        // quant=dynamic — ~1/3 веса полной модели, в ~2-3x быстрее по CPU.
        await m.loadModel({ path: '/dtln-web/', quant: 'dynamic' });
        return {
          sampleRate: m.sampleRate,
          createNode: (ctx: BaseAudioContext) =>
            m.createDtlnProcessorNode(ctx, { channelCount: 1 }),
        };
      } finally {
        // Возвращаем оригинальный WebAssembly.Memory — DFN-3 и другие
        // пакеты, которым нужен SAB, должны работать как обычно.
        (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = origMemory;
      }
    })().catch((err) => {
      apiPromise = null;
      throw err;
    });
  }
  return apiPromise;
}
