/**
 * 10-секундная запись обработанного потока через MediaRecorder.
 * Итог — WebM/Opus blob; скачивается с именем clip-{mode}-{timestamp}.webm.
 */
const RECORD_DURATION_MS = 10_000;
export function recordClip(opts) {
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(opts.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    let stoppedManually = false;
    recorder.ondataavailable = (e) => {
        if (e.data.size > 0)
            chunks.push(e.data);
    };
    recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        download(blob, `clip-${opts.mode}-${tsForFilename()}.webm`);
        opts.onDone?.();
    };
    recorder.start();
    // Прогресс-таймер для UI.
    const startedAt = Date.now();
    const tick = () => {
        if (recorder.state !== 'recording')
            return;
        const left = RECORD_DURATION_MS - (Date.now() - startedAt);
        opts.onProgress?.(Math.max(0, left));
        if (left > 0)
            requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const timer = window.setTimeout(() => {
        if (recorder.state === 'recording' && !stoppedManually)
            recorder.stop();
    }, RECORD_DURATION_MS);
    return {
        stop: () => {
            stoppedManually = true;
            window.clearTimeout(timer);
            if (recorder.state === 'recording')
                recorder.stop();
        },
    };
}
function pickMimeType() {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
    ];
    for (const mt of candidates) {
        if (MediaRecorder.isTypeSupported(mt))
            return mt;
    }
    return null;
}
function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tsForFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
