#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

mkdir -p data/swift-cache bin
swiftc -O -module-cache-path data/swift-cache \
  bin/dictlookup.swift -o bin/dictlookup \
  -framework CoreServices
swiftc -O -module-cache-path data/swift-cache \
  bin/pdftext.swift -o bin/pdftext \
  -framework PDFKit -framework AppKit
chmod +x bin/dictlookup bin/pdftext

echo "Built bin/dictlookup and bin/pdftext"
