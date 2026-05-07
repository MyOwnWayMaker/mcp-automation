#!/usr/bin/env bash
# setup_watch.sh - registers the compress_videos LaunchAgent.
# Portable mode: relies on the static ffmpeg/ffprobe in ./bin/ (placed there
# by install.sh) and uses launchd's built-in WatchPaths trigger -- no brew,
# no fswatch, no Xcode CLT required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_LABEL="com.hakiel.compress-videos"
PLIST_DEST="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
WATCH_DIR="${WATCH_DIR:-${HOME}/CompressMe}"
DONE_DIR="${DONE_DIR:-${WATCH_DIR}/done}"

echo "==> setup_watch.sh"
echo "    SCRIPT_DIR : $SCRIPT_DIR"
echo "    WATCH_DIR  : $WATCH_DIR"
echo "    DONE_DIR   : $DONE_DIR"
echo "    PLIST_DEST : $PLIST_DEST"
echo

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: setup_watch.sh is for macOS. Detected $(uname -s)." >&2
  exit 1
fi

# Prefer the local ./bin/ (static binaries from install.sh) over the system,
# in case the user has a partial system install of ffmpeg.
export PATH="${SCRIPT_DIR}/bin:${PATH}"
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool not found." >&2
    echo "  install.sh should have placed it in $SCRIPT_DIR/bin/." >&2
    echo "  Re-run: curl -fsSL ${BASE:-https://raw.githubusercontent.com/MyOwnWayMaker/mcp-automation/main/mac-tools/compress-videos}/install.sh | bash" >&2
    exit 1
  fi
done

mkdir -p "$WATCH_DIR" "$DONE_DIR" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
chmod +x "${SCRIPT_DIR}/compress_videos.sh" \
         "${SCRIPT_DIR}/compress_videos_watch.sh" \
         "${SCRIPT_DIR}/fix_hevc_tag.sh" \
         "${SCRIPT_DIR}/dl.sh" \
         "${SCRIPT_DIR}/remux.sh" 2>/dev/null || true

echo "==> Rendering LaunchAgent plist -> $PLIST_DEST"
sed \
  -e "s|__SCRIPT_DIR__|${SCRIPT_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "${SCRIPT_DIR}/compress_videos.plist" > "$PLIST_DEST"

echo "==> (Re)loading LaunchAgent ($PLIST_LABEL)"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load   "$PLIST_DEST"

echo
echo "Installed."
echo
echo "Drop a video into:  $WATCH_DIR"
echo "Compressed result:  $DONE_DIR (or in place if you set IN_PLACE=1)"
echo "Live log:           tail -f ~/Library/Logs/compress_videos.log"
echo
echo "Disable: launchctl unload \"$PLIST_DEST\""
echo "Re-enable: launchctl load \"$PLIST_DEST\""
echo
launchctl list | grep -F "$PLIST_LABEL" || echo "(LaunchAgent not visible yet - give it a few seconds.)"
