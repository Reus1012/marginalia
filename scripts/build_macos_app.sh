#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt
fi
if [ ! -x .venv/bin/pyinstaller ]; then
  .venv/bin/python -m pip install pyinstaller
fi
if [ ! -x bin/dictlookup ] || [ ! -x bin/pdftext ]; then
  ./scripts/build_helpers.sh
fi

mkdir -p .pyinstaller
PYINSTALLER_CONFIG_DIR="$PWD/.pyinstaller" .venv/bin/pyinstaller \
  --noconfirm --clean --windowed \
  --name Marginalia \
  --osx-bundle-identifier local.marginalia.reader \
  --add-data "static:static" \
  --add-data "bin/dictlookup:bin" \
  --add-data "bin/pdftext:bin" \
  app.py

xattr -cr dist/Marginalia.app || true
codesign --force --deep --sign - dist/Marginalia.app || true

ditto -c -k --keepParent dist/Marginalia.app dist/Marginalia-macOS-arm64.zip
echo "Built dist/Marginalia.app and dist/Marginalia-macOS-arm64.zip"
