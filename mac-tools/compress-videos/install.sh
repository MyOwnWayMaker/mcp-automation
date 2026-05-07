#!/usr/bin/env bash
# install.sh - portable bootstrap (no Homebrew, no Xcode CLT required).
# Downloads static ffmpeg/ffprobe binaries plus the 4 toolkit scripts and
# loads the LaunchAgent. ~150 MB of disk required (vs. 11.8 GB for brew + CLT).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos/install.sh | bash

set -euo pipefail

DEST="${HOME}/compress-videos"
BIN="$DEST/bin"
BASE="https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos"
FILES=(
  compress_videos.sh
  compress_videos_watch.sh
  compress_videos.plist
  setup_watch.sh
  fix_hevc_tag.sh
  dl.sh
  remux.sh
  README.md
)

echo "==> Cleaning $DEST"
rm -rf "$DEST"
mkdir -p "$BIN"
cd "$DEST"

for f in "${FILES[@]}"; do
  echo "==> Fetching $f"
  curl -fsSL -o "$f" "$BASE/$f"
done

# evermeet.cx provides static macOS ffmpeg/ffprobe builds. /getrelease/ is
# the latest stable; we follow redirects with -L. Each zip is ~30 MB.
echo
echo "==> Downloading static ffmpeg from evermeet.cx (~30 MB)..."
curl -fsSL -o /tmp/_compvid_ffmpeg.zip   "https://evermeet.cx/ffmpeg/getrelease/zip"
echo "==> Downloading static ffprobe from evermeet.cx (~30 MB)..."
curl -fsSL -o /tmp/_compvid_ffprobe.zip  "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"

echo "==> Extracting..."
unzip -oq /tmp/_compvid_ffmpeg.zip   -d "$BIN"
unzip -oq /tmp/_compvid_ffprobe.zip  -d "$BIN"
rm -f /tmp/_compvid_ffmpeg.zip /tmp/_compvid_ffprobe.zip

chmod +x "$BIN/ffmpeg" "$BIN/ffprobe"

echo "==> Verifying binaries"
if ! "$BIN/ffmpeg" -version >/dev/null 2>&1; then
  echo
  echo "WARN: ffmpeg failed to run on this Mac. If you're on Apple Silicon,"
  echo "      Rosetta 2 may not be installed. Install it with:"
  echo
  echo "      softwareupdate --install-rosetta --agree-to-license"
  echo
  echo "      Then re-run this installer."
  exit 1
fi
"$BIN/ffmpeg"  -version | head -1
"$BIN/ffprobe" -version | head -1

echo
echo "==> Files in $DEST:"
ls -la "$DEST"
echo "==> Files in $BIN:"
ls -la "$BIN"
echo

echo "==> Running setup_watch.sh"
bash "$DEST/setup_watch.sh"
