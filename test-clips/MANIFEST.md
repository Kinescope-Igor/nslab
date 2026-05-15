# Тестовый набор аудио для noise-bench

**Назначение:** покрыть типичные сценарии, в которых работает Speak — голосовая запись на встречах, в кафе, дома, на улице. Минимум 5 типов шума + 2 SNR-уровня + 1 чистая дорожка для sanity-check.

**Лицензии:** только **MIT / Public Domain / CC0** — стенд можно показывать клиентам без оговорок про CC BY-NC или Freesound-attribution.

---

## Структура

```
test-clips/
├── clean/                     # эталонная речь без шума
│   ├── ru-female.wav
│   ├── ru-male.wav
│   └── en-male.wav
├── noise/                     # «сырой» шум без голоса
│   ├── cafe.wav               # кафе / babble
│   ├── street-traffic.wav     # машины
│   ├── office-keyboard.wav    # печать клавиатуры
│   ├── ac-fan.wav             # кондиционер / вентилятор (стационарный)
│   ├── baby-cry.wav           # детский плач (резкий, эмоциональный)
│   └── room-reverb.wav        # эхо комнаты (другой класс задач, для контроля)
└── mixed/                     # clean + noise на разных SNR (создаются скриптом)
    ├── ru-female_cafe_5dB.wav
    ├── ru-female_cafe_0dB.wav
    ├── ru-male_keyboard_5dB.wav
    ├── ...
```

Mixed-клипы генерирует `make-mixed.sh` через ffmpeg (скейл noise по RMS, чтобы получить нужный SNR относительно clean).

---

## Источники и лицензии

### Чистая речь (clean/)

| Файл | Источник | Лицензия | Описание |
|---|---|---|---|
| `mssnsd_clnsp0.wav` | MS-SNSD `clean_test/clnsp0.wav` | **MIT** | Английская речь, ~10 сек |
| `mssnsd_clnsp1.wav` | MS-SNSD `clean_test/clnsp1.wav` | **MIT** | Английская речь, ~10 сек |
| `mssnsd_clnsp2.wav` | MS-SNSD `clean_test/clnsp2.wav` | **MIT** | Английская речь, ~10 сек |

> **Примечание:** русская речь (Common Voice ru) пока не подключена — там нужен dump через API (требует ключа). Если для Speak важно проверить именно на русских голосах — добавим отдельным шагом, попросим коллег записать 3 коротких клипа сами либо вытянем из открытых русских корпусов (OpenSTT).

### Шумы (noise/)

| Файл | Источник | Лицензия | Описание |
|---|---|---|---|
| `cafe-babble.wav` | MS-SNSD `noise_test/Babble_1.wav` | **MIT** | Шум кафе / babble |
| `office-keyboard.wav` | MS-SNSD `Typing_1.wav` | **MIT** | Печать на клавиатуре, импульсный шум |
| `ac-fan.wav` | MS-SNSD `AirConditioner_1.wav` | **MIT** | Стационарный шум кондиционера |
| `vacuum.wav` | MS-SNSD `VacuumCleaner_1.wav` | **MIT** | Пылесос / стационарный широкополосный |
| `neighbor.wav` | MS-SNSD `Neighbor_1.wav` | **MIT** | Соседи через стену, нестационарный |
| `munching.wav` | MS-SNSD `Munching_1.wav` | **MIT** | Звуки еды у микрофона (типичный кейс) |

MS-SNSD: [github.com/microsoft/MS-SNSD](https://github.com/microsoft/MS-SNSD), все файлы MIT.

Дополнительно скачано в `reference/`:
- 4 клипа из **DTLN-rs demo** (Datadog, MIT) — `airconditioning`, `dog_barking_noisy`, `restaurant_noisy`, `trump_vs_helicopter`. Полезны для прямого сравнения с публичной демо Datadog.
- 4 клипа из **DeepFilterNet assets** (Rikorose, MIT) — `clean_freesound`, `noise_freesound_*`, `noisy_snr0`. Полезны для прямого сравнения с собственным DFN-3 benchmark.

---

## SNR-уровни в mixed/

Для каждой пары (clean × noise) генерируем **3 версии**:

- **+5 dB SNR** — лёгкий шум (комфортный фон).
- **0 dB SNR** — равная громкость (типичный кейс кафе, где шумодав реально нужен).
- **−5 dB SNR** — шум громче речи (стресс-тест, тут DFN-3 должен сильно обогнать RNNoise).

Итого: 3 clean × 6 noise × 3 SNR = **54 mixed-клипа** + 3 raw-clean + 6 raw-noise = **63 файла**, ~30 MB total.

Для UI стенда показываем подмножество (4-6 пар по дефолту), остальные — для углублённого тестирования.

---

## Как воспроизвести набор

1. `bash download.sh` — скачивает источники в `_raw/`, нарезает clean-фрагменты.
2. `bash make-mixed.sh` — генерирует все mixed/ файлы через ffmpeg.
3. `bash verify.sh` — проверяет, что все файлы существуют, sample rate 16/48 kHz, mono, 10 сек ±0.5.

---

## Приёмка набора

- ☐ 3 clean файла, 10 ±0.5 сек каждый, 48 kHz mono.
- ☐ 6 noise файлов, 10 сек каждый, 48 kHz mono.
- ☐ 54 mixed файла на трёх SNR.
- ☐ Все лицензии Public Domain / CC0 / MIT (или CC BY с указанием в README стенда).
- ☐ Total размер ≤ 50 MB (для быстрой загрузки в браузер).
- ☐ В UI стенда — preset-list с типичными сценариями: «офис + клавиатура», «кафе babble», «улица», «дом + детский плач», «комната с эхо».
