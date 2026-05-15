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

echo "=== 3. DeepFilterNet (Rikorose) — reference assets ==="
DFN_RAW="https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/assets"
curl -sL "$DFN_RAW/clean_freesound_33711.wav" -o "reference/dfn_clean.wav"
curl -sL "$DFN_RAW/noise_freesound_2530.wav" -o "reference/dfn_noise_a.wav"
curl -sL "$DFN_RAW/noise_freesound_573577.wav" -o "reference/dfn_noise_b.wav"
curl -sL "$DFN_RAW/noisy_snr0.wav" -o "reference/dfn_noisy_snr0.wav"
echo "  reference/dfn_*.wav (4 файла)"

echo "=== 4. DTLN-rs (Datadog) — pre-noisy demo clips ==="
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
