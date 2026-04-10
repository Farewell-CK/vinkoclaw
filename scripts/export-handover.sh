#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OUT_DIR="/home/xsuper/workspace/tmp"
OUT_DIR="${1:-$DEFAULT_OUT_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_PATH="${OUT_DIR}/vinkoclaw-source-${STAMP}.tar.gz"
MANIFEST_PATH="${OUT_DIR}/vinkoclaw-source-${STAMP}.manifest.txt"

mkdir -p "$OUT_DIR"

echo "[export] root: $ROOT_DIR"
echo "[export] out : $ARCHIVE_PATH"

tar \
  --exclude=".git" \
  --exclude="node_modules" \
  --exclude=".data" \
  --exclude=".run" \
  --exclude=".env" \
  --exclude=".env.local" \
  --exclude="coverage" \
  --exclude="dist" \
  --exclude="*.log" \
  -czf "$ARCHIVE_PATH" \
  -C "$(dirname "$ROOT_DIR")" \
  "$(basename "$ROOT_DIR")"

cat > "$MANIFEST_PATH" <<EOF
archive: $ARCHIVE_PATH
created_at_utc: $STAMP
source_root: $ROOT_DIR
excluded:
  - .git
  - node_modules
  - .data
  - .run
  - .env
  - .env.local
  - coverage
  - dist
  - *.log
EOF

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE_PATH" >> "$MANIFEST_PATH"
fi

echo "[export] done"
echo "[export] archive : $ARCHIVE_PATH"
echo "[export] manifest: $MANIFEST_PATH"
