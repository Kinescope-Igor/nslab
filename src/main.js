import { start, stop, setMode, setSource, setGain, state } from './audio/pipeline';
import { Spectrogram } from './audio/spectrogram';
import { recordClip } from './audio/recorder';
import * as dnsmos from './audio/dnsmos';
// Material Web components — подгружаем только то, что используем.
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/labs/card/elevated-card.js';
import '@material/web/labs/card/outlined-card.js';
import '@material/web/radio/radio.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/slider/slider.js';
const $ = (sel) => document.querySelector(sel);
const btnStart = $('#btn-start');
const btnStop = $('#btn-stop');
const btnRecord = $('#btn-record');
const btnRecordLabel = $('#btn-record-label');
const mState = $('#m-state');
const mRms = $('#m-rms');
const mSr = $('#m-sr');
const mVad = $('#m-vad');
const sourceSelect = $('#source-select');
const gainSlider = $('#gain-slider');
const gainLabel = $('#gain-label');
const spectrogramCanvas = $('#spectrogram');
const modesContainer = document.querySelector('.modes-card');
const spectrogram = new Spectrogram(spectrogramCanvas);
const mSig = $('#m-sig');
const mBak = $('#m-bak');
const mOvr = $('#m-ovr');
const mosStatus = $('#mos-status');
function resetMetrics() {
    mRms.textContent = '—';
    mVad.textContent = '—';
    mSig.textContent = '—';
    mBak.textContent = '—';
    mOvr.textContent = '—';
    mosStatus.textContent = 'ожидание данных';
}
let mosTimer = null;
let mosBusy = false;
function startMosLoop() {
    if (mosTimer !== null)
        return;
    // Inference выполняется в Web Worker (src/workers/dnsmos-worker.ts) —
    // main thread не блокируется, RAF/AudioWorklet остаются плавными.
    mosTimer = window.setTimeout(function tick() {
        runMosOnce();
        mosTimer = window.setTimeout(tick, 3000);
    }, 9000);
}
function stopMosLoop() {
    if (mosTimer !== null) {
        window.clearTimeout(mosTimer);
        mosTimer = null;
    }
    mosBusy = false;
}
async function runMosOnce() {
    if (mosBusy || !state.capture || !state.context)
        return;
    mosBusy = true;
    mosStatus.textContent = 'инференс…';
    const snapshot = await new Promise((resolve) => {
        if (!state.capture)
            return resolve(null);
        const cap = state.capture;
        const timeout = window.setTimeout(() => {
            cap.port.onmessage = null;
            resolve(null);
        }, 500);
        cap.port.onmessage = (e) => {
            if (e.data?.type === 'snapshot') {
                window.clearTimeout(timeout);
                cap.port.onmessage = null;
                resolve({ samples: e.data.samples, sampleRate: e.data.sampleRate });
            }
        };
        cap.port.postMessage({ type: 'snapshot' });
    });
    if (!snapshot) {
        mosBusy = false;
        mosStatus.textContent = 'ошибка снимка';
        return;
    }
    try {
        // Resample выполняется внутри dnsmos worker — main thread free.
        const result = await dnsmos.score(snapshot.samples, snapshot.sampleRate);
        mSig.textContent = result.sig.toFixed(2);
        mBak.textContent = result.bak.toFixed(2);
        mOvr.textContent = result.ovr.toFixed(2);
        mosStatus.textContent = `обновлено · ${result.segments} окно/окон`;
    }
    catch (err) {
        console.error('DNSMOS error', err);
        mosStatus.textContent = `ошибка: ${err.message}`;
    }
    finally {
        mosBusy = false;
    }
}
state.onRms = (dbfs) => {
    mRms.textContent = dbfs.toFixed(1);
};
state.onVad = (vad) => {
    mVad.textContent = Number.isFinite(vad) ? vad.toFixed(2) : '—';
};
function selectedSource() {
    const v = sourceSelect.value || 'mic';
    return v === 'mic' ? { kind: 'mic' } : { kind: 'file', url: v };
}
function updateGainLabel(value) {
    const db = value > 0 ? 20 * Math.log10(value) : -Infinity;
    gainLabel.textContent = `${value.toFixed(1)}× (${db === -Infinity ? '−∞' : (db >= 0 ? '+' : '') + db.toFixed(1)} dB)`;
}
updateGainLabel(state.gainValue);
gainSlider.addEventListener('input', () => {
    const v = Number(gainSlider.value);
    if (!Number.isFinite(v))
        return;
    setGain(v);
    updateGainLabel(v);
});
function attachSpectrogram() {
    if (state.analyser)
        spectrogram.attach(state.analyser);
}
btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    mState.textContent = 'starting…';
    try {
        await setSource(selectedSource()); // фиксируем источник в state до start()
        await start();
        mState.textContent = 'running';
        mSr.textContent = String(state.context.sampleRate);
        btnStop.disabled = false;
        btnRecord.disabled = false;
        sourceSelect.disabled = true;
        attachSpectrogram();
        startMosLoop();
    }
    catch (err) {
        console.error(err);
        mState.textContent = `error: ${err.message}`;
        resetMetrics();
        btnStart.disabled = false;
    }
});
btnStop.addEventListener('click', async () => {
    stopMosLoop();
    spectrogram.detach();
    await stop();
    mState.textContent = 'idle';
    mSr.textContent = '—';
    resetMetrics();
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnRecord.disabled = true;
    sourceSelect.disabled = false;
});
modesContainer.addEventListener('change', async (event) => {
    const target = event.target;
    if (target.tagName?.toLowerCase() !== 'md-radio')
        return;
    if (target.name !== 'mode' || !target.checked || !target.value)
        return;
    const value = target.value;
    try {
        await setMode(value);
        mVad.textContent = '—';
        // После смены mode analyser пересоздан внутри pipeline (если sample rate
        // менялся) — переподключаем spectrogram к актуальному.
        attachSpectrogram();
    }
    catch (err) {
        console.error('setMode failed', err);
        mState.textContent = `mode error: ${err.message}`;
        resetMetrics();
    }
});
let activeRecording = null;
btnRecord.addEventListener('click', () => {
    if (activeRecording) {
        activeRecording.stop();
        return;
    }
    if (!state.recorderDest)
        return;
    btnRecord.classList.add('recording');
    btnRecordLabel.textContent = 'Запись… 10';
    activeRecording = recordClip({
        stream: state.recorderDest.stream,
        mode: state.mode,
        onProgress: (msLeft) => {
            btnRecordLabel.textContent = `Запись… ${Math.ceil(msLeft / 1000)}`;
        },
        onDone: () => {
            activeRecording = null;
            btnRecord.classList.remove('recording');
            btnRecordLabel.textContent = 'Записать 10 сек';
        },
    });
});
