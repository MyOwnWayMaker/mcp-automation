#!/usr/bin/env bash
# compress_videos.sh — recursively re-encode video files to H.265 (HEVC) to
# reclaim disk space. Skips files already in HEVC. Only replaces the original
# when the new file is meaningfully smaller (default: < 80% of original).
#
# Usage:
#   compress_videos.sh [--dry-run] [--threshold N] [--verbose] PATH
#
# PATH may be a directory (recursed) or a single file.
#
# Exit status: 0 on completion (per-file errors are logged, not fatal).

set -uo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
THRESHOLD=80                # only replace when new size < THRESHOLD% of original
DRY_RUN=0
VERBOSE=0
LOG_FILE="${LOG_FILE:-${HOME}/Library/Logs/compress_videos.log}"

usage() {
  cat <<EOF
Usage: $0 [--dry-run] [--threshold N] [--verbose] PATH

  PATH        Directory (recursed) OR a single video file.
  --dry-run   Walk the tree and report what would be done — no encoding.
  --threshold N  Replacement threshold as a percent (default 80). New file
                 is kept only when its size is < N% of the original.
  --verbose   Show ffmpeg progress in addition to errors.
  -h, --help  Show this help and exit.

Environment:
  LOG_FILE     Override log path (default ~/Library/Logs/compress_videos.log).
EOF
}

# ─── Flag parsing ────────────────────────────────────────────────────────────
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; shift ;;
    --threshold)      THRESHOLD="$2"; shift 2 ;;
    --threshold=*)    THRESHOLD="${1#--threshold=}"; shift ;;
    --verbose|-v)     VERBOSE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    --)               shift; TARGET="${1:-}"; shift || true; break ;;
    -*)               echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)                if [[ -z "$TARGET" ]]; then TARGET="$1"; else echo "Multiple paths not supported." >&2; exit 2; fi; shift ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -e "$TARGET" ]]; then
  echo "Path does not exist: $TARGET" >&2
  exit 1
fi
if ! [[ "$THRESHOLD" =~ ^[0-9]+$ ]] || (( THRESHOLD < 1 || THRESHOLD > 100 )); then
  echo "--threshold must be an integer 1–100 (got '$THRESHOLD')" >&2
  exit 2
fi

# ─── Tool checks ─────────────────────────────────────────────────────────────
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool not found in PATH: $tool" >&2
    echo "  Install with: brew install ffmpeg" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$LOG_FILE")"

# ─── Logger ──────────────────────────────────────────────────────────────────
log() {
  local ts; ts="$(date '+%Y-%m-%d %H:%M:%S')"
  printf '%s %s\n' "$ts" "$*" | tee -a "$LOG_FILE"
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

# file_size — emit byte count (portable across macOS BSD stat + GNU stat).
file_size() {
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"      # macOS / BSD
  else
    stat -c%s "$1"      # GNU / Linux / Git-Bash
  fi
}

# fmt_gb — bytes → "1.23 GB" string. Uses awk for floating-point.
fmt_gb() {
  awk -v b="$1" 'BEGIN { printf "%.2f", b/1024/1024/1024 }'
}

# is_hevc — exit 0 when first video stream is H.265/HEVC.
is_hevc() {
  local codec
  codec=$(ffprobe -v error -select_streams v:0 \
            -show_entries stream=codec_name \
            -of default=nokey=1:noprint_wrappers=1 \
            "$1" 2>/dev/null || true)
  case "$codec" in
    hevc|h265|HEVC) return 0 ;;
    *) return 1 ;;
  esac
}

# Pick output extension. HEVC sits cleanly in mp4-family containers and mkv;
# avi + webm don't, so those become mp4. Idempotent re-runs see the new mp4
# and skip via is_hevc.
out_ext_for() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    mp4|m4v|mov|mkv) printf '%s' "$lower" ;;
    *)               printf '%s' "mp4" ;;
  esac
}

# ─── Counters ────────────────────────────────────────────────────────────────
TOTAL_FILES=0
SKIPPED_HEVC=0
SKIPPED_INSUFF=0
REPLACED=0
ERRORS=0
NONVIDEO=0
ORIG_BYTES=0
NEW_BYTES=0

# ─── Per-file processing ─────────────────────────────────────────────────────
process_file() {
  local in="$1"
  local ext="${in##*.}"
  local lower; lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  local dir;   dir="$(dirname "$in")"
  local stem;  stem="$(basename "$in" ".$ext")"

  TOTAL_FILES=$((TOTAL_FILES + 1))

  # Codec check first — cheap, lets us skip without size arithmetic noise.
  if is_hevc "$in"; then
    local sz; sz="$(file_size "$in")"
    ORIG_BYTES=$((ORIG_BYTES + sz))
    NEW_BYTES=$((NEW_BYTES + sz))
    SKIPPED_HEVC=$((SKIPPED_HEVC + 1))
    log "SKIP-HEVC   $(fmt_gb "$sz")GB  $in"
    return 0
  fi

  local orig_sz; orig_sz="$(file_size "$in")"
  if [[ -z "$orig_sz" || "$orig_sz" -eq 0 ]]; then
    log "ERROR       could not stat (zero bytes?): $in"
    ERRORS=$((ERRORS + 1))
    return 0
  fi

  local out_ext; out_ext="$(out_ext_for "$lower")"
  local out_path="${dir}/${stem}.${out_ext}"
  # Encode to a sibling tmp file so a crash mid-run can't truncate the input.
  # Unique-per-pid suffix avoids parallel-run collisions; '.compressing.tmp'
  # extension is excluded by find so a leftover won't be re-processed.
  local tmp="${dir}/.${stem}.compressing-$$.tmp.${out_ext}"

  if (( DRY_RUN )); then
    # Heuristic estimate: ~50% reduction is typical for SDR consumer video
    # going from H.264 medium → H.265 medium @ CRF 26.
    local est_new=$((orig_sz / 2))
    ORIG_BYTES=$((ORIG_BYTES + orig_sz))
    NEW_BYTES=$((NEW_BYTES + est_new))
    log "DRY-RUN     orig=$(fmt_gb "$orig_sz")GB  est_new=$(fmt_gb "$est_new")GB  $in"
    return 0
  fi

  log "ENCODING    $(fmt_gb "$orig_sz")GB  $in"

  local ff_loglevel="error"
  (( VERBOSE )) && ff_loglevel="info"

  # -y overwrite tmp; -nostdin so a watcher invocation doesn't hang on input;
  # -map 0 keeps every stream (audio + subs); -c:s copy keeps subs without
  # re-encoding (HEVC + mp4 supports mov_text; mkv handles all).
  if ! ffmpeg -hide_banner -nostdin -loglevel "$ff_loglevel" -y \
         -i "$in" \
         -map 0 \
         -c:v libx265 -crf 26 -preset medium \
         -c:a copy \
         -c:s copy \
         "$tmp" 2>>"$LOG_FILE"; then
    rm -f "$tmp"
    ERRORS=$((ERRORS + 1))
    log "ERROR       encode failed: $in"
    return 0
  fi

  local new_sz; new_sz="$(file_size "$tmp")"
  if [[ -z "$new_sz" || "$new_sz" -eq 0 ]]; then
    rm -f "$tmp"
    ERRORS=$((ERRORS + 1))
    log "ERROR       new file empty: $in"
    return 0
  fi

  # Integer percent comparison: new * 100 / orig
  local pct=$(( new_sz * 100 / orig_sz ))

  if (( pct < THRESHOLD )); then
    # Replace. If the output extension changed (avi/webm → mp4), remove the
    # original after moving the new file into its target name.
    if ! mv -f "$tmp" "$out_path"; then
      rm -f "$tmp"
      ERRORS=$((ERRORS + 1))
      log "ERROR       could not move tmp into place: $tmp → $out_path"
      return 0
    fi
    if [[ "$out_path" != "$in" ]]; then
      rm -f "$in"
    fi
    REPLACED=$((REPLACED + 1))
    ORIG_BYTES=$((ORIG_BYTES + orig_sz))
    NEW_BYTES=$((NEW_BYTES + new_sz))
    log "REPLACED    orig=$(fmt_gb "$orig_sz")GB  new=$(fmt_gb "$new_sz")GB  ratio=${pct}%  $out_path"
  else
    rm -f "$tmp"
    SKIPPED_INSUFF=$((SKIPPED_INSUFF + 1))
    ORIG_BYTES=$((ORIG_BYTES + orig_sz))
    NEW_BYTES=$((NEW_BYTES + orig_sz))
    log "SKIP-RATIO  orig=$(fmt_gb "$orig_sz")GB  attempted=$(fmt_gb "$new_sz")GB  ratio=${pct}% (>= ${THRESHOLD}%)  $in"
  fi
}

# ─── Walk + dispatch ─────────────────────────────────────────────────────────

# Canonicalize for the start banner. realpath is GNU-only on Linux but
# present on macOS via coreutils-style binary; fall back to absolute-via-cd.
target_abs="$TARGET"
if command -v realpath >/dev/null 2>&1; then
  target_abs="$(realpath "$TARGET" 2>/dev/null || echo "$TARGET")"
fi

log "===== compress_videos.sh START path=$target_abs threshold=${THRESHOLD}% dry_run=$DRY_RUN ====="

if [[ -f "$TARGET" ]]; then
  # Single-file mode (used by the watcher).
  case "$(printf '%s' "${TARGET##*.}" | tr '[:upper:]' '[:lower:]')" in
    mp4|mov|avi|mkv|m4v|webm)
      process_file "$TARGET"
      ;;
    *)
      NONVIDEO=$((NONVIDEO + 1))
      log "SKIP-NONVID $TARGET"
      ;;
  esac
elif [[ -d "$TARGET" ]]; then
  # Recurse. -print0 + read -d '' handles spaces / newlines / unicode in paths.
  while IFS= read -r -d '' file; do
    process_file "$file"
  done < <(find "$TARGET" -type f \( \
    -iname '*.mp4' -o -iname '*.mov'  -o -iname '*.avi' -o \
    -iname '*.mkv' -o -iname '*.m4v'  -o -iname '*.webm' \) -print0)
else
  echo "Path is neither file nor directory: $TARGET" >&2
  exit 1
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
SAVED=$((ORIG_BYTES - NEW_BYTES))
log "===== compress_videos.sh DONE ====="
log "  total=$TOTAL_FILES  replaced=$REPLACED  skipped_hevc=$SKIPPED_HEVC  skipped_ratio=$SKIPPED_INSUFF  errors=$ERRORS"
log "  original=$(fmt_gb "$ORIG_BYTES")GB  new=$(fmt_gb "$NEW_BYTES")GB  freed=$(fmt_gb "$SAVED")GB"
