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
      // full-precision — DNSMOS теперь в Worker, главный thread свободен,
      // должен потянуть. Качество заметно выше quant_dynamic.
      await m.loadModel({ path: '/dtln-web/' });
      return {
        sampleRate: m.sampleRate,
        createNode: (ctx: BaseAudioContext) =>
          m.createDtlnProcessorNode(ctx, { channelCount: 1 }),
      };
    })().catch((err) => {
      apiPromise = null;
      throw err;
    });
  }
  return apiPromise;
}
