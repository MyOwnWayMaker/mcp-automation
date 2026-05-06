#!/usr/bin/env bash
# fix_hevc_tag.sh - Rewrite the codec tag on existing HEVC mp4s from
# `hev1` to `hvc1` so Apple QuickTime / Finder / Photos will play them.
#
# Pure remux: -c copy means no re-encoding, just rewrites the container
# header. Takes seconds per file, doesn't touch the actual video data.
# Files already tagged hvc1 (or non-HEVC) are skipped.
#
# Usage:
#   fix_hevc_tag.sh [DIR]
#
# DIR defaults to ~/CompressMe/done. Scans recursively.

set -uo pipefail

TARGET="${1:-${HOME}/CompressMe/done}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer the static binaries shipped with the toolkit.
export PATH="${SCRIPT_DIR}/bin:${PATH}"

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool not in PATH" >&2
    exit 1
  fi
done

if [[ ! -d "$TARGET" ]]; then
  echo "ERROR: not a directory: $TARGET" >&2
  exit 1
fi

echo "Scanning $TARGET for hev1-tagged HEVC files..."
echo

TOTAL=0
RETAGGED=0
SKIPPED_NONHEVC=0
SKIPPED_ALREADY=0
ERRORS=0

while IFS= read -r -d '' f; do
  TOTAL=$((TOTAL + 1))

  # Pull codec_name + codec_tag_string for video stream 0 in one ffprobe call.
  # csv=p=0 gives us "hevc,hev1" (one line, no headers); tr ',' ' ' splits it
  # into two whitespace-separated fields that read can parse directly.
  read -r codec tag < <(ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,codec_tag_string \
    -of csv=p=0 "$f" 2>/dev/null | tr ',' ' ')

  if [[ "${codec:-}" != "hevc" ]]; then
    SKIPPED_NONHEVC=$((SKIPPED_NONHEVC + 1))
    continue
  fi
  if [[ "${tag:-}" == "hvc1" ]]; then
    SKIPPED_ALREADY=$((SKIPPED_ALREADY + 1))
    continue
  fi

  ext="${f##*.}"
  tmp="${f%.*}.retag-$$.tmp.${ext}"
  printf 'retag: %s\n' "$f"

  if ffmpeg -hide_banner -nostdin -loglevel error -y \
       -i "$f" -c copy -tag:v hvc1 "$tmp" 2>/dev/null; then
    if mv -f "$tmp" "$f"; then
      RETAGGED=$((RETAGGED + 1))
    else
      rm -f "$tmp"
      ERRORS=$((ERRORS + 1))
      printf '  FAIL: could not move tmp into place\n' >&2
    fi
  else
    rm -f "$tmp"
    ERRORS=$((ERRORS + 1))
    printf '  FAIL: ffmpeg remux failed (tag: %s)\n' "${tag:-?}" >&2
  fi
done < <(find "$TARGET" -type f \( -iname '*.mp4' -o -iname '*.m4v' -o -iname '*.mov' \) -print0)

echo
printf 'Done. total=%d  retagged=%d  skipped_already_hvc1=%d  skipped_non_hevc=%d  errors=%d\n' \
  "$TOTAL" "$RETAGGED" "$SKIPPED_ALREADY" "$SKIPPED_NONHEVC" "$ERRORS"
