#!/usr/bin/env bash
# Копирует DTLN-runtime файлы из node_modules в public/dtln-web/.
# Запускается автоматически через postinstall (см. package.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/@sapphi-red/dtln-web/dist"
DST="$ROOT/public/dtln-web"

if [[ ! -d "$SRC" ]]; then
  echo "skip: $SRC не существует (пакет не установлен)"
  exit 0
fi

mkdir -p "$DST"
cp "$SRC/model_1.tflite"                   "$DST/"
cp "$SRC/model_2.tflite"                   "$DST/"
cp "$SRC/tflite_web_api_cc_simd.js"        "$DST/"
cp "$SRC/tflite_web_api_cc_simd.wasm"      "$DST/"
echo "DTLN assets copied → $DST"
