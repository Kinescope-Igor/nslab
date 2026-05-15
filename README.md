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
- [ ] RNNoise WASM (interop с тем же модулем, что в speak/frontend).
- [ ] DTLN-rs WASM (из репо DataDog/dtln-rs).
- [ ] DeepFilterNet 3 lite через onnxruntime-web.
- [ ] DNSMOS P.835 рядом с каждым плеером.
- [ ] Spectrogram waterfall.
- [ ] Запись 10s clip × 4 для blind A/B/C/D.
- [ ] Деплой на `kn.pe/lab/noise-bench/` (COOP/COEP, HTTPS).

План: [`/Users/igors/claudecode/noise_bench_plan.md`](/Users/igors/claudecode/noise_bench_plan.md).

## Лицензия

MIT.
