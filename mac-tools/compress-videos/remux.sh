#!/usr/bin/env bash
# remux.sh - Repair an HLS-derived mp4 that failed yt-dlp's FixupM3u8 step.
#
# Why this exists: when yt-dlp downloads an HLS (.m3u8) stream with its
# native downloader, it concatenates raw .ts segments into an mp4 wrapper
# and runs a "FixupM3u8" pass to re-mux the MPEG-TS framing. That pass
# fails on streams carrying timed_id3 metadata (very common on HLS) or
# when audio uses ADTS framing that mp4 can't hold without conversion.
# This script does both fixes:
#   - drops auxiliary streams (timed_id3, etc.) via -map 0:v -map 0:a
#   - converts AAC ADTS framing to mp4-friendly ASC framing
#   - stream-copies video and audio (no re-encoding, runs in seconds)
#
# Usage:
#   bash ~/compress-videos/remux.sh
#   (paste the broken file path when prompted)
#
# Or with arg (if your terminal pastes cleanly):
#   bash ~/compress-videos/remux.sh '/path/to/broken.mp4'

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FFMPEG="${SCRIPT_DIR}/bin/ffmpeg"

if [[ ! -x "$FFMPEG" ]]; then
  echo "ERROR: ffmpeg not found at $FFMPEG" >&2
  exit 1
fi

IN="${1:-}"

if [[ -z "$IN" ]]; then
  printf 'Paste the full path to the broken video file, then press Enter:\n> '
  IFS= read -r IN
fi

# Trim whitespace from paste artifacts
IN="${IN#"${IN%%[![:space:]]*}"}"
IN="${IN%"${IN##*[![:space:]]}"}"

if [[ -z "$IN" ]]; then
  echo "ERROR: no input path provided" >&2
  exit 2
fi
if [[ ! -f "$IN" ]]; then
  echo "ERROR: file not found: $IN" >&2
  exit 1
fi

DIR="$(dirname "$IN")"
BASE="$(basename "$IN")"
STEM="${BASE%.*}"
OUT="${DIR}/${STEM}.fixed.mp4"

# If a previous fix attempt left an artifact, get it out of the way.
if [[ -e "$OUT" ]]; then
  echo "Note: removing previous attempt at $OUT"
  rm -f "$OUT"
fi

echo
echo "Input:  $IN"
echo "Output: $OUT"
echo "Working..."
echo

if "$FFMPEG" -hide_banner -nostdin -loglevel warning \
     -i "$IN" \
     -map 0:v -map 0:a \
     -c copy \
     -bsf:a aac_adtstoasc \
     "$OUT"; then
  echo
  echo "SUCCESS. New file:"
  ls -lh "$OUT"
  echo
  echo "Test playback by double-clicking it. If it plays, delete the original:"
  echo "  rm \"$IN\""
else
  status=$?
  echo
  echo "ERROR: ffmpeg exited with status $status" >&2
  rm -f "$OUT"
  exit "$status"
fi
