#!/usr/bin/env bash
# dl.sh - download a video URL into ~/CompressMe/ via yt-dlp.
#
# Prompts for URL + optional referer interactively. Interactive prompts
# sidestep the terminal-paste-mangling that breaks long command-line
# arguments with spaces between quoted tokens (bracketed-paste quirk on
# some macOS terminal setups).
#
# Usage:
#   bash ~/compress-videos/dl.sh
#   (then paste the URL when prompted, paste the referer when prompted)
#
# Or with args (if your terminal pastes cleanly):
#   bash ~/compress-videos/dl.sh 'URL' 'REFERER'

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YT="${SCRIPT_DIR}/bin/yt-dlp"
FFMPEG_DIR="${SCRIPT_DIR}/bin"
DEST="${DEST:-${HOME}/CompressMe}"

if [[ ! -x "$YT" ]]; then
  echo "ERROR: yt-dlp not found at $YT" >&2
  echo "Install: curl -L -o '$YT' https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos && chmod +x '$YT'" >&2
  exit 1
fi

mkdir -p "$DEST"

URL="${1:-}"
REFERER="${2:-}"

if [[ -z "$URL" ]]; then
  printf 'Paste the video URL (the .m3u8 or .mp4 from DevTools), then press Enter:\n> '
  IFS= read -r URL
fi

if [[ -z "$REFERER" ]]; then
  printf '\nPaste the page URL the video is embedded on (or press Enter to skip referer):\n> '
  IFS= read -r REFERER
fi

# Trim leading/trailing whitespace that pasting sometimes adds
URL="${URL#"${URL%%[![:space:]]*}"}"
URL="${URL%"${URL##*[![:space:]]}"}"
REFERER="${REFERER#"${REFERER%%[![:space:]]*}"}"
REFERER="${REFERER%"${REFERER##*[![:space:]]}"}"

if [[ -z "$URL" ]]; then
  echo "ERROR: no URL provided" >&2
  exit 2
fi

echo
echo "URL:     $URL"
echo "Referer: ${REFERER:-<none>}"
echo "Dest:    $DEST"
echo

cmd=("$YT" -P "$DEST" --ffmpeg-location "$FFMPEG_DIR")
if [[ -n "$REFERER" ]]; then
  cmd+=(--referer "$REFERER")
fi
cmd+=("$URL")

"${cmd[@]}"
