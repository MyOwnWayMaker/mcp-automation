#!/usr/bin/env bash
# update.sh - refresh the toolkit's shell scripts in place. Does NOT
# re-download ffmpeg/ffprobe (those binaries are stable; install.sh handles
# them). Use this when only the .sh logic has changed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos/update.sh | bash

set -euo pipefail

DEST="${HOME}/compress-videos"
BASE="https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos"
FILES=(
  compress_videos.sh
  compress_videos_watch.sh
  fix_hevc_tag.sh
  dl.sh
)

if [[ ! -d "$DEST" ]]; then
  echo "ERROR: $DEST not found. Run install.sh first." >&2
  exit 1
fi

cd "$DEST"

for f in "${FILES[@]}"; do
  echo "==> Fetching $f"
  curl -fsSL -o "$f.new" "$BASE/$f"
  mv -f "$f.new" "$f"
  chmod +x "$f"
done

echo
echo "==> Updated. The next launchd trigger will use the new logic."
echo "    To force a scan now: touch ~/CompressMe"
