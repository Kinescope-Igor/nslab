import { start, stop, setMode, state, Mode } from './audio/pipeline';

// Material Web components — подгружаем только то, что используем.
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/labs/card/elevated-card.js';
import '@material/web/labs/card/outlined-card.js';
import '@material/web/radio/radio.js';

const $ = (sel: string) => document.querySelector(sel)!;

const btnStart = $('#btn-start') as HTMLButtonElement;
const btnStop = $('#btn-stop') as HTMLButtonElement;
const mState = $('#m-state') as HTMLSpanElement;
const mRms = $('#m-rms') as HTMLSpanElement;
const mSr = $('#m-sr') as HTMLSpanElement;
const mVad = $('#m-vad') as HTMLSpanElement;

const modeRadios = document.querySelectorAll<HTMLElement>('md-radio[name="mode"]');
const modesContainer = document.querySelector('.modes-card')!;

function resetMetrics() {
  mRms.textContent = '—';
  mVad.textContent = '—';
}

state.onRms = (dbfs) => {
  mRms.textContent = dbfs.toFixed(1);
};

state.onVad = (vad) => {
  // У DTLN/passthrough VAD нет — pipeline шлёт NaN. Показываем '—', не "NaN".
  mVad.textContent = Number.isFinite(vad) ? vad.toFixed(2) : '—';
};

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  mState.textContent = 'starting…';

  try {
    await start();
    mState.textContent = 'running';
    mSr.textContent = String(state.context!.sampleRate);
    btnStop.disabled = false;
  } catch (err) {
    console.error(err);
    mState.textContent = `error: ${(err as Error).message}`;
    resetMetrics();
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', async () => {
  await stop();
  mState.textContent = 'idle';
  mSr.textContent = '—';
  resetMetrics();
  btnStart.disabled = false;
  btnStop.disabled = true;
});

// Type-safe radio handler через делегирование на контейнер: ловим change с
// конкретного <md-radio>, читаем .value напрямую с target. Без `as any`.
modesContainer.addEventListener('change', async (event) => {
  const target = event.target as HTMLElement & { name?: string; value?: string; checked?: boolean };
  if (target.tagName?.toLowerCase() !== 'md-radio') return;
  if (target.name !== 'mode' || !target.checked || !target.value) return;
  const value = target.value as Mode;

  try {
    await setMode(value);
    // Сбросим VAD до нового тика — иначе UI на момент свапа может показывать
    // старое значение от предыдущего режима (особенно при переходе в DTLN).
    mVad.textContent = '—';
  } catch (err) {
    console.error('setMode failed', err);
    mState.textContent = `mode error: ${(err as Error).message}`;
    resetMetrics();
  }
});

// Не используем переменную, но оставляем — на случай прямого доступа из консоли.
void modeRadios;
