#!/bin/bash
cd "$(dirname "$0")" || exit 1

if [ ! -x .venv/bin/python ]; then
  PY=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PY="$candidate"
      break
    fi
  done
  if [ -z "$PY" ]; then
    echo "Python 3.10 or newer is required."
    echo "Install it from python.org, then double-click this file again."
    read -r -p "Press Return to close…" _
    exit 1
  fi
  echo "Creating the local Python environment…"
  "$PY" -m venv .venv || exit 1
  .venv/bin/python -m pip install --no-cache-dir -r requirements.txt || exit 1
fi

if .venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=1)" >/dev/null 2>&1; then
  open "http://127.0.0.1:8765/"
  exit 0
fi

mkdir -p data/swift-cache
if [ ! -x bin/dictlookup ] && [ -f bin/dictlookup.swift ]; then
  echo "Building the Oxford dictionary helper…"
  swiftc -O -module-cache-path data/swift-cache bin/dictlookup.swift -o bin/dictlookup -framework CoreServices 2>/dev/null
  chmod +x bin/dictlookup 2>/dev/null
fi
if [ ! -x bin/pdftext ] && [ -f bin/pdftext.swift ]; then
  echo "Building the native PDF text helper…"
  swiftc -O -module-cache-path data/swift-cache bin/pdftext.swift -o bin/pdftext -framework PDFKit -framework AppKit 2>/dev/null
  chmod +x bin/pdftext 2>/dev/null
fi

exec .venv/bin/python app.py
