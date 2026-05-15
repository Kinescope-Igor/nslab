#!/usr/bin/env bash
# Копирует DTLN-runtime файлы из node_modules в public/dtln-web/.
# Запускается автоматически через postinstall (см. package.json).
#
# @sapphi-red/dtln-web на старте определяет capabilities браузера и грузит
# подходящий вариант: simd / simd_threaded (если есть SAB+COEP/COOP) и т.п.
# Поэтому копируем все 4 варианта tflite-runtime + соответствующие worker'ы.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/@sapphi-red/dtln-web/dist"
DST="$ROOT/public/dtln-web"

if [[ ! -d "$SRC" ]]; then
  echo "skip: $SRC не существует (пакет не установлен)"
  exit 0
fi

mkdir -p "$DST"

# Модели DTLN: quant=dynamic (~1 MB total) — в 2-3 раза легче по CPU,
# чем full-precision. Для real-time-monitor через ScriptProcessorNode критично.
cp "$SRC/model_quant_dynamic_1.tflite" "$DST/"
cp "$SRC/model_quant_dynamic_2.tflite" "$DST/"

# Все 4 варианта tflite WASM runtime + worker'ы для threaded-вариантов.
for variant in cc cc_simd cc_threaded cc_simd_threaded; do
  cp "$SRC/tflite_web_api_${variant}.wasm" "$DST/"
  cp "$SRC/tflite_web_api_${variant}.js"   "$DST/"
  if [[ "$variant" == *threaded ]]; then
    cp "$SRC/tflite_web_api_${variant}.worker.js" "$DST/"
  fi
done

echo "DTLN assets copied → $DST ($(ls "$DST" | wc -l | tr -d ' ') files, $(du -sh "$DST" | cut -f1))"
