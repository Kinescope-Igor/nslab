import { start, stop, setMode, setSource, state, Mode, SourceConfig } from './audio/pipeline';
import { Spectrogram } from './audio/spectrogram';
import { recordClip } from './audio/recorder';

// Material Web components — подгружаем только то, что используем.
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/labs/card/elevated-card.js';
import '@material/web/labs/card/outlined-card.js';
import '@material/web/radio/radio.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';

const $ = (sel: string) => document.querySelector(sel)!;

const btnStart = $('#btn-start') as HTMLButtonElement;
const btnStop = $('#btn-stop') as HTMLButtonElement;
const btnRecord = $('#btn-record') as HTMLButtonElement;
const btnRecordLabel = $('#btn-record-label') as HTMLSpanElement;
const mState = $('#m-state') as HTMLSpanElement;
const mRms = $('#m-rms') as HTMLSpanElement;
const mSr = $('#m-sr') as HTMLSpanElement;
const mVad = $('#m-vad') as HTMLSpanElement;
const sourceSelect = $('#source-select') as HTMLElement & { value?: string; disabled?: boolean };
const spectrogramCanvas = $('#spectrogram') as HTMLCanvasElement;
const modesContainer = document.querySelector('.modes-card')!;

const spectrogram = new Spectrogram(spectrogramCanvas);

function resetMetrics() {
  mRms.textContent = '—';
  mVad.textContent = '—';
}

state.onRms = (dbfs) => {
  mRms.textContent = dbfs.toFixed(1);
};

state.onVad = (vad) => {
  mVad.textContent = Number.isFinite(vad) ? vad.toFixed(2) : '—';
};

function selectedSource(): SourceConfig {
  const v = sourceSelect.value || 'mic';
  return v === 'mic' ? { kind: 'mic' } : { kind: 'file', url: v };
}

function attachSpectrogram() {
  if (state.analyser) spectrogram.attach(state.analyser);
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  mState.textContent = 'starting…';

  try {
    await setSource(selectedSource()); // фиксируем источник в state до start()
    await start();
    mState.textContent = 'running';
    mSr.textContent = String(state.context!.sampleRate);
    btnStop.disabled = false;
    btnRecord.disabled = false;
    sourceSelect.disabled = true;
    attachSpectrogram();
  } catch (err) {
    console.error(err);
    mState.textContent = `error: ${(err as Error).message}`;
    resetMetrics();
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', async () => {
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
  const target = event.target as HTMLElement & { name?: string; value?: string; checked?: boolean };
  if (target.tagName?.toLowerCase() !== 'md-radio') return;
  if (target.name !== 'mode' || !target.checked || !target.value) return;
  const value = target.value as Mode;

  try {
    await setMode(value);
    mVad.textContent = '—';
    // После смены mode analyser пересоздан внутри pipeline (если sample rate
    // менялся) — переподключаем spectrogram к актуальному.
    attachSpectrogram();
  } catch (err) {
    console.error('setMode failed', err);
    mState.textContent = `mode error: ${(err as Error).message}`;
    resetMetrics();
  }
});

let activeRecording: { stop: () => void } | null = null;

btnRecord.addEventListener('click', () => {
  if (activeRecording) {
    activeRecording.stop();
    return;
  }
  if (!state.recorderDest) return;

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
