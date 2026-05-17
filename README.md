# NSLab — Noise Suppression Lab

A/B-сравнение шумодавов в браузере в реальном времени:

- **RNNoise** (Xiph/Mozilla, baseline — то, что у Speak frontend сейчас)
- **DTLN-rs** (Datadog, минимальная латентность)
- **DeepFilterNet 3** (Rikorose, state-of-the-art качество)

Плюс **DNSMOS P.835** (Microsoft) — non-intrusive метрика качества.

Назначение: дать команде Speak / Kinescope быстрый веб-стенд, на котором можно
надеть наушники, переключить radio-кнопку «raw / RNNoise / DTLN / DFN-3» и
услышать разницу в реальном времени на собственных аудио-кейсах.

Хостинг: [`speak.kn.pe/lab/noise-bench/`](https://speak.kn.pe/lab/noise-bench/).

## Локальный запуск

```bash
npm install
npm run dev
```

Открыть [http://localhost:5173/](http://localhost:5173/), разрешить микрофон,
нажать «Включить микрофон». **Использовать наушники!** — иначе будет feedback.

## Тестовый набор аудио

В `test-clips/` лежат скрипты для скачивания эталонного набора (MS-SNSD,
DTLN-rs demo, DeepFilterNet assets — всё MIT-лицензировано). Сами `.wav` в
git не коммитятся:

```bash
cd test-clips/
bash download.sh    # 16 раз .wav, ~24 MB
bash make-mixed.sh  # 54 mixed-клипа на трёх SNR через ffmpeg, ~18 MB
```

Подробности и лицензии — в [`test-clips/MANIFEST.md`](test-clips/MANIFEST.md).

## Статус

- [x] Скелет: Vite + TS + AudioWorklet, passthrough работает.
- [x] RNNoise через `@shiguredo/rnnoise-wasm` (main thread + forwarder worklet).
- [x] DTLN через `@sapphi-red/dtln-web` (TFLite, 16 kHz, ScriptProcessorNode).
- [x] DeepFilterNet 3 через **self-built WASM** из Rikorose/DeepFilterNet
   (libDF + wasm-pack, target no-modules). Артефакты в `public/dfn3-self/`,
   процесс сборки в [`/Users/igors/claudecode/dfn3_build_report.md`](/Users/igors/claudecode/dfn3_build_report.md).
- [x] Spectrogram waterfall (Canvas2D, log-spaced bins).
- [x] DNSMOS P.835 в Web Worker (onnxruntime-web + sig_bak_ovr.onnx).
- [x] Запись 10s clip → `clip-{mode}-{timestamp}.webm`.
- [x] Sample clips — 6 mixed на 0 dB SNR в dropdown.
- [x] Деплой на `speak.kn.pe/lab/noise-bench/` (HTTPS, MIME для .wasm/.onnx).

## Деплой

Локально: `npm run build` → `dist/`. Затем:

```bash
rsync -az --delete --exclude='*.map' dist/ \
  igor@89.23.107.2:/var/www/speak.kn.pe/lab/noise-bench/
```

nginx config: `/etc/nginx/sites-available/messenger` — `location ^~ /lab/`
с alias + явные MIME для `.wasm/.onnx/.tflite/.bin`. Кэш immutable для
hashed assets, 1-day must-revalidate для ML-моделей.

План: [`/Users/igors/claudecode/noise_bench_plan.md`](/Users/igors/claudecode/noise_bench_plan.md).

## Лицензия

MIT.
