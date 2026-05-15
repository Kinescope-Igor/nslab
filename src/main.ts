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

state.onRms = (dbfs) => {
  mRms.textContent = dbfs.toFixed(1);
};

state.onVad = (vad) => {
  if (mVad) mVad.textContent = vad.toFixed(2);
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
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', async () => {
  await stop();
  mState.textContent = 'idle';
  mRms.textContent = '—';
  mSr.textContent = '—';
  if (mVad) mVad.textContent = '—';
  btnStart.disabled = false;
  btnStop.disabled = true;
});

modeRadios.forEach((r) => {
  r.addEventListener('change', async () => {
    const checked = (r as any).checked;
    const value = (r as any).value as Mode;
    if (checked) {
      try {
        await setMode(value);
      } catch (err) {
        console.error('setMode failed', err);
        mState.textContent = `mode error: ${(err as Error).message}`;
      }
    }
  });
});
