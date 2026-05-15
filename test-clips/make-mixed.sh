#!/usr/bin/env bash
# Микширует clean × noise на трёх SNR (-5/0/+5 dB).
# Требует: ffmpeg.

set -euo pipefail
cd "$(dirname "$0")"
mkdir -p mixed

CLEAN=( clean/mssnsd_clnsp0.wav clean/mssnsd_clnsp1.wav clean/mssnsd_clnsp2.wav )
NOISE=( noise/ac-fan.wav noise/cafe-babble.wav noise/office-keyboard.wav noise/neighbor.wav noise/vacuum.wav noise/munching.wav )
SNR=( 5 0 -5 )

# Получает RMS dBFS аудио-файла (число вроде -22.4)
rms_dbfs() {
    ffmpeg -hide_banner -nostats -i "$1" -af "volumedetect" -f null /dev/null 2>&1 \
        | grep "mean_volume" | awk -F': ' '{print $2}' | awk '{print $1}'
}

mix_one() {
    local clean="$1"
    local noise="$2"
    local snr="$3"
    local out="$4"

    local clean_db noise_db gain_db
    clean_db=$(rms_dbfs "$clean")
    noise_db=$(rms_dbfs "$noise")
    # хотим: rms_noise_after = rms_clean - snr → gain = (rms_clean - snr) - rms_noise
    gain_db=$(python3 -c "print(${clean_db} - ${snr} - ${noise_db})")

    ffmpeg -y -hide_banner -loglevel error \
        -i "$clean" -i "$noise" \
        -filter_complex "[1:a]aloop=loop=-1:size=2147483647,atrim=0:duration=10,volume=${gain_db}dB[n];[0:a][n]amix=inputs=2:duration=first:normalize=0" \
        -ar 16000 -ac 1 -c:a pcm_s16le "$out"
}

for c in "${CLEAN[@]}"; do
    cname=$(basename "$c" .wav | sed 's/mssnsd_//')
    for n in "${NOISE[@]}"; do
        nname=$(basename "$n" .wav)
        for snr in "${SNR[@]}"; do
            out="mixed/${cname}_${nname}_${snr}dB.wav"
            mix_one "$c" "$n" "$snr" "$out"
            echo "  $out"
        done
    done
done

echo
echo "=== Готово ==="
echo "  $(ls mixed/ | wc -l | tr -d ' ') миксов в mixed/"
echo "  total: $(du -sh mixed/ | cut -f1)"
