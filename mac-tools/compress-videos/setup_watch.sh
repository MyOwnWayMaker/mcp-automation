#!/usr/bin/env bash
# setup_watch.sh - one-time installer for the compress_videos watcher on macOS.
# Installs ffmpeg + fswatch, generates the LaunchAgent plist with the right
# paths, and loads it so the watcher starts now and at every login.

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

# --- Sanity: this is only meant to run on macOS. Bail loudly elsewhere. ------
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: setup_watch.sh is for macOS. Detected $(uname -s)." >&2
  exit 1
fi

# --- Homebrew ----------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Install it first from https://brew.sh, then re-run." >&2
  exit 1
fi

# --- ffmpeg + fswatch --------------------------------------------------------
for pkg in ffmpeg fswatch; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    echo "==> $pkg already installed."
  else
    echo "==> Installing $pkg via brew..."
    brew install "$pkg"
  fi
done

# --- Folders -----------------------------------------------------------------
mkdir -p "$WATCH_DIR" "$DONE_DIR" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

# --- Make scripts executable ------------------------------------------------
chmod +x "${SCRIPT_DIR}/compress_videos.sh" "${SCRIPT_DIR}/compress_videos_watch.sh"

# --- Render plist with absolute paths ----------------------------------------
echo "==> Rendering LaunchAgent plist -> $PLIST_DEST"
sed \
  -e "s|__SCRIPT_DIR__|${SCRIPT_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "${SCRIPT_DIR}/compress_videos.plist" > "$PLIST_DEST"

# --- (Re)load the agent ------------------------------------------------------
echo "==> Reloading LaunchAgent ($PLIST_LABEL)"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load   "$PLIST_DEST"

# --- Status ------------------------------------------------------------------
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
