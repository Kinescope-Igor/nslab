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
let apiPromise = null;
export async function init() {
    if (!apiPromise) {
        apiPromise = (async () => {
            const m = await import('@sapphi-red/dtln-web');
            const base = new URL('dtln-web/', document.baseURI).href;
            await m.setup(base);
            // full-precision — DNSMOS теперь в Worker, главный thread свободен,
            // должен потянуть. Качество заметно выше quant_dynamic.
            await m.loadModel({ path: base });
            return {
                sampleRate: m.sampleRate,
                createNode: (ctx) => m.createDtlnProcessorNode(ctx, { channelCount: 1 }),
            };
        })().catch((err) => {
            apiPromise = null;
            throw err;
        });
    }
    return apiPromise;
}
