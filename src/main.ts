import { start, stop, setMode, state, Mode } from './audio/pipeline';

const $ = (sel: string) => document.querySelector(sel)!;

const btnStart = $('#btn-start') as HTMLButtonElement;
const btnStop = $('#btn-stop') as HTMLButtonElement;
const mState = $('#m-state') as HTMLSpanElement;
const mRms = $('#m-rms') as HTMLSpanElement;
const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  mState.textContent = 'starting…';

  try {
    await start();
    mState.textContent = `running (${state.context!.sampleRate} Hz)`;
    btnStop.disabled = false;

    // Подписка на RMS-сообщения из worklet.
    state.worklet!.port.onmessage = (e) => {
      if (e.data?.type === 'rms') {
        mRms.textContent = e.data.dbfs.toFixed(1);
      }
    };
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
  btnStart.disabled = false;
  btnStop.disabled = true;
});

modeRadios.forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) setMode(r.value as Mode);
  });
});
