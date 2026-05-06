#!/usr/bin/env bash
# compress_videos_watch.sh - fswatch daemon for ~/CompressMe/.
# Drop a video in, watcher waits for the copy to finish, then runs
# compress_videos.sh on it. On success, moves the result to ~/CompressMe/done/
# (or leaves it in place if IN_PLACE=1).
#
# Run by hand (foreground) for testing, or via the LaunchAgent for daemon mode.

set -uo pipefail

# --- Config ------------------------------------------------------------------
WATCH_DIR="${WATCH_DIR:-${HOME}/CompressMe}"
DONE_DIR="${DONE_DIR:-${WATCH_DIR}/done}"
THRESHOLD="${THRESHOLD:-80}"
IN_PLACE="${IN_PLACE:-0}"           # 1 = leave compressed file where it landed
LOG_FILE="${LOG_FILE:-${HOME}/Library/Logs/compress_videos.log}"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-5}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPRESS="${COMPRESS:-${SCRIPT_DIR}/compress_videos.sh}"

mkdir -p "$WATCH_DIR" "$DONE_DIR" "$(dirname "$LOG_FILE")"

# --- Logger ------------------------------------------------------------------
log() {
  printf '%s [watch] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

# --- Tool checks -------------------------------------------------------------
for tool in fswatch ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR required tool not in PATH: $tool - run setup_watch.sh first"
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
# DEBOUNCE_SECONDS seconds. This handles "still copying" cases - Drive sync,
# AirDrop, slow USB transfer, etc. Bails after ~10 minutes of churn.
wait_until_stable() {
  local f="$1"
  local prev=-1 cur deadline
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
  return 1   # file vanished
}

# Process one video: run compress_videos.sh on it, move/keep result.
handle() {
  local in="$1"

  # Skip files in the done/ subfolder (post-compress destination).
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

  # Determine post-compress path. compress_videos.sh may have changed the
  # extension if the source was avi/webm.
  local result="$in"
  if [[ ! -f "$in" ]]; then
    local stem="${in%.*}"
    if [[ -f "${stem}.mp4" ]]; then result="${stem}.mp4"; fi
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

# --- Main loop ---------------------------------------------------------------
log "starting on $WATCH_DIR (threshold=${THRESHOLD}%, in_place=${IN_PLACE}, debounce=${DEBOUNCE_SECONDS}s)"
log "log file: $LOG_FILE"

# fswatch -0 emits NUL-terminated paths (safe for spaces/newlines).
# --latency batches rapid-fire events. We then filter inside handle().
fswatch -0 \
  --latency="$DEBOUNCE_SECONDS" \
  --event=Created \
  --event=Updated \
  --event=Renamed \
  "$WATCH_DIR" \
| while IFS= read -r -d '' path; do
    handle "$path"
  done
