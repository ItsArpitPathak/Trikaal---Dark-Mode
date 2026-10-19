#!/usr/bin/env bash
# Builds dist/trikaal-<version>.zip containing ONLY the files the extension needs.
# Usage (from anywhere):  bash scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(grep -m1 '"version"' manifest.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')
mkdir -p dist
out="dist/trikaal-${version}.zip"
rm -f "$out"
# Tests, docs, scripts and editor files are deliberately absent.
zip -r -X "$out" manifest.json background content popup shared icons
echo "Created $out"
