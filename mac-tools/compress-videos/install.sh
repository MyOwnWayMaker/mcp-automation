#!/usr/bin/env bash
# install.sh - one-line bootstrap. Pipe via:
#   curl -fsSL https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos/install.sh | bash
#
# Downloads the 5 toolkit files into ~/compress-videos/ and runs setup_watch.sh.
# Safe to re-run: existing folder is wiped first.

set -euo pipefail

DEST="${HOME}/compress-videos"
BASE="https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos"
FILES=(
  compress_videos.sh
  compress_videos_watch.sh
  compress_videos.plist
  setup_watch.sh
  README.md
)

echo "==> Cleaning $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

for f in "${FILES[@]}"; do
  echo "==> Fetching $f"
  curl -fsSL -o "$f" "$BASE/$f"
done

echo
echo "==> Files downloaded:"
ls -la "$DEST"
echo

echo "==> Running setup_watch.sh"
bash "$DEST/setup_watch.sh"
