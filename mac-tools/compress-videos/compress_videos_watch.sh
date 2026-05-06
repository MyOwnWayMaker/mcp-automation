#!/usr/bin/env bash
# compress_videos_watch.sh - launched by launchd each time WatchPaths fires
# on ~/CompressMe/. Runs ONCE per invocation: scans the folder for stable
# video files, processes each, exits. launchd re-fires on the next change.
#
# No fswatch dependency - relies entirely on launchd WatchPaths.

set -uo pipefail

# --- Config ------------------------------------------------------------------
WATCH_DIR="${WATCH_DIR:-${HOME}/CompressMe}"
DONE_DIR="${DONE_DIR:-${WATCH_DIR}/done}"
THRESHOLD="${THRESHOLD:-80}"
IN_PLACE="${IN_PLACE:-0}"
LOG_FILE="${LOG_FILE:-${HOME}/Library/Logs/compress_videos.log}"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-5}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPRESS="${COMPRESS:-${SCRIPT_DIR}/compress_videos.sh}"

# Prefer the static binaries shipped with the toolkit.
export PATH="${SCRIPT_DIR}/bin:${PATH}"

mkdir -p "$WATCH_DIR" "$DONE_DIR" "$(dirname "$LOG_FILE")"

# --- Logger ------------------------------------------------------------------
log() {
  printf '%s [watch] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

# --- Tool checks -------------------------------------------------------------
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR required tool not in PATH: $tool"
    exit 1
  fi
done
[[ -x "$COMPRESS" ]] || { log "ERROR compress_videos.sh not executable at $COMPRESS"; exit 1; }

file_size() {
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"; else stat -c%s "$1"; fi
}

# is_video - case-insensitive extension match against the allow-list.
is_video() {
  local lower; lower="$(printf '%s' "${1##*.}" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    mp4|mov|avi|mkv|m4v|webm) return 0 ;;
    *) return 1 ;;
  esac
}

# wait_until_stable - poll the file size until it hasn't changed for
# DEBOUNCE_SECONDS. Handles "still copying" cases.
wait_until_stable() {
  local f="$1" prev=-1 cur deadline
  deadline=$(( $(date +%s) + 600 ))
  while [[ -f "$f" ]]; do
    cur="$(file_size "$f" 2>/dev/null || echo -1)"
    if [[ "$cur" == "$prev" && "$cur" != "0" && "$cur" != "-1" ]]; then
      return 0
    fi
    if (( $(date +%s) > deadline )); then
      log "WARN copy never stabilized after 10min, processing anyway: $f"
      return 0
    fi
    prev="$cur"
    sleep "$DEBOUNCE_SECONDS"
  done
  return 1
}

handle() {
  local in="$1"

  case "$in" in
    "$DONE_DIR"/*) return 0 ;;
    *.compressing.tmp.*|*.compressing-*.tmp.*) return 0 ;;
  esac
  is_video "$in" || return 0
  [[ -f "$in" ]] || return 0

  log "candidate $in"
  wait_until_stable "$in" || { log "vanished mid-copy $in"; return 0; }
  log "stable, processing $in"

  if ! bash "$COMPRESS" --threshold "$THRESHOLD" "$in" 2>>"$LOG_FILE"; then
    log "ERROR compress_videos.sh exited non-zero on $in"
    return 0
  fi

  local result="$in"
  if [[ ! -f "$in" ]]; then
    local stem="${in%.*}"
    [[ -f "${stem}.mp4" ]] && result="${stem}.mp4"
  fi

  if (( IN_PLACE )); then
    log "kept in place $result"
  else
    if [[ -f "$result" ]]; then
      if mv -f "$result" "$DONE_DIR/"; then
        log "moved -> $DONE_DIR/$(basename "$result")"
      else
        log "ERROR move-to-done failed for $result"
      fi
    fi
  fi
}

# --- Main: scan once, exit -------------------------------------------------
log "trigger fired, scanning $WATCH_DIR"

# Flat watch dir (not recursive). done/ is excluded inside handle().
while IFS= read -r -d '' f; do
  handle "$f"
done < <(find "$WATCH_DIR" -maxdepth 1 -type f \( \
  -iname '*.mp4' -o -iname '*.mov' -o -iname '*.avi' -o \
  -iname '*.mkv' -o -iname '*.m4v' -o -iname '*.webm' \) -print0)

log "scan complete"
