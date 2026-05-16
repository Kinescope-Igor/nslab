#!/usr/bin/env bash
# Скачивает тестовый набор для noise-bench из MIT-лицензированных источников.
# Запускать из папки test-clips/.

set -euo pipefail

mkdir -p clean noise reference mixed

echo "=== 1. MS-SNSD (Microsoft) — clean speech ==="
MSSNSD_RAW="https://raw.githubusercontent.com/microsoft/MS-SNSD/master"
for i in 0 1 2; do
    curl -sL "$MSSNSD_RAW/clean_test/clnsp${i}.wav" -o "clean/mssnsd_clnsp${i}.wav"
    echo "  clean/mssnsd_clnsp${i}.wav"
done

echo "=== 2. MS-SNSD — noise samples ==="
declare -a NOISE=(
    "AirConditioner_1.wav:ac-fan.wav"
    "Babble_1.wav:cafe-babble.wav"
    "Typing_1.wav:office-keyboard.wav"
    "Traffic_1.wav:street-traffic.wav"
    "VacuumCleaner_1.wav:vacuum.wav"
    "Munching_1.wav:munching.wav"
)
for pair in "${NOISE[@]}"; do
    src="${pair%%:*}"
    dst="${pair##*:}"
    if curl -sLf "$MSSNSD_RAW/noise_test/${src}" -o "noise/${dst}"; then
        echo "  noise/${dst}"
    else
        echo "  ! не нашёл noise_test/${src} (категория могла измениться)"
    fi
done

echo "=== 3. Living Audio Dataset (Idlak) — русский clean speech ==="
# Apache 2.0 / public domain audio (LibriVox). Один спикер ABR (female, 48 kHz mono).
# Качаем tar.gz (~142 MB) с archive.org, склеиваем 4 коротких фрагмента в 10-sec clip.
if [ ! -f "_raw/lad-ru.tar.gz" ]; then
    mkdir -p _raw
    curl -sL -o _raw/lad-ru.tar.gz \
        "https://archive.org/download/ru.ru.abr.48000.tar/ru.ru.abr.48000.tar.gz"
fi
mkdir -p _raw/lad-ru-extract
tar xzf _raw/lad-ru.tar.gz -C _raw/lad-ru-extract --skip-old-files 2>/dev/null || true
LAD_DIR="_raw/lad-ru-extract/48000_orig"
cat > _raw/lad-concat.txt <<EOF
file '../$LAD_DIR/abr_z0001_003.wav'
file '../$LAD_DIR/abr_z0001_006.wav'
file '../$LAD_DIR/abr_z0001_010.wav'
file '../$LAD_DIR/abr_z0001_014.wav'
EOF
ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i _raw/lad-concat.txt \
    -ar 16000 -ac 1 -t 10 -c:a pcm_s16le clean/lad_ru_female.wav
echo "  clean/lad_ru_female.wav (10 sec, 16 kHz mono, женский голос)"

echo "=== 4. DeepFilterNet (Rikorose) — reference assets ==="
DFN_RAW="https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/assets"
curl -sL "$DFN_RAW/clean_freesound_33711.wav" -o "reference/dfn_clean.wav"
curl -sL "$DFN_RAW/noise_freesound_2530.wav" -o "reference/dfn_noise_a.wav"
curl -sL "$DFN_RAW/noise_freesound_573577.wav" -o "reference/dfn_noise_b.wav"
curl -sL "$DFN_RAW/noisy_snr0.wav" -o "reference/dfn_noisy_snr0.wav"
echo "  reference/dfn_*.wav (4 файла)"

echo "=== 5. DTLN-rs (Datadog) — pre-noisy demo clips ==="
DTLN_RAW="https://raw.githubusercontent.com/DataDog/dtln-rs/main/clips"
curl -sL "$DTLN_RAW/airconditioning.wav"      -o "reference/dtln_ac.wav"
curl -sL "$DTLN_RAW/dog_barking_noisy.wav"    -o "reference/dtln_dog.wav"
curl -sL "$DTLN_RAW/restaurant_noisy.wav"     -o "reference/dtln_restaurant.wav"
curl -sL "$DTLN_RAW/trump_vs_helicopter.wav"  -o "reference/dtln_helicopter.wav"
echo "  reference/dtln_*.wav (4 файла)"

echo
echo "=== Готово ==="
ls -lh clean/ noise/ reference/ 2>/dev/null
echo
echo "Дальше: bash make-mixed.sh — смикширует clean × noise на трёх SNR (-5/0/+5 dB)."
