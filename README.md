# NSLab — Noise Suppression Lab

A/B-сравнение шумодавов в браузере в реальном времени:

- **RNNoise** (Xiph/Mozilla, baseline — то, что у Speak frontend сейчас)
- **DTLN-rs** (Datadog, минимальная латентность)
- **DeepFilterNet 3** (Rikorose, state-of-the-art качество)

Плюс **DNSMOS P.835** (Microsoft) — non-intrusive метрика качества.

Назначение: дать команде Speak / Kinescope быстрый веб-стенд, на котором можно
надеть наушники, переключить radio-кнопку «raw / RNNoise / DTLN / DFN-3» и
услышать разницу в реальном времени на собственных аудио-кейсах.

Хостинг: [`kn.pe/lab/noise-bench`](https://kn.pe/lab/noise-bench/) (планируется).

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
- [ ] **DeepFilterNet 3 — отключён.** `deepfilter-standalone` бросает
   `RuntimeError: unreachable` в `df_create()` независимо от наличия SAB и
   значения `attenuationLimit`. Альтернативный wrapper
   (`livekit-deepfilternet3-noise-filter` от phuvinh010701) поставляется
   с GitHub без pre-built dist. Чтобы починить: либо собрать DFN-3 WASM
   из Rust сорсов через wasm-pack, либо реализовать DFN-3 pipeline на
   onnxruntime-web + sub-models из tar.gz напрямую. Заготовка кода
   осталась в `src/audio/dfn3.ts` + `pipeline.ts` (case `dfn3`).
- [ ] DNSMOS P.835 рядом с каждым плеером.
- [ ] Spectrogram waterfall.
- [ ] Запись 10s clip × 4 для blind A/B/C/D.
- [ ] Деплой на `kn.pe/lab/noise-bench/` (HTTPS, MIME для .wasm).

План: [`/Users/igors/claudecode/noise_bench_plan.md`](/Users/igors/claudecode/noise_bench_plan.md).

## Лицензия

MIT.
