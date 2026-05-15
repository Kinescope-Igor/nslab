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
      const m = await import('@sapphi-red/dtln-web');
      await m.setup('/dtln-web/');
      // quant=dynamic — ~1/3 веса полной модели, в ~2-3x быстрее по CPU.
      // Для real-time через ScriptProcessorNode (main thread) критично.
      await m.loadModel({ path: '/dtln-web/', quant: 'dynamic' });
      return {
        sampleRate: m.sampleRate,
        createNode: (ctx: BaseAudioContext) =>
          m.createDtlnProcessorNode(ctx, { channelCount: 1 }),
      };
    })().catch((err) => {
      // Сбрасываем кэш, иначе следующий init() мгновенно вернёт rejected
      // promise без попытки реинициализации (404 / network blip → permanent fail).
      apiPromise = null;
      throw err;
    });
  }
  return apiPromise;
}
