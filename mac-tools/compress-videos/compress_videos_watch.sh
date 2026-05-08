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
# When invoked by launchd, stdout is already redirected to LOG_FILE via the
# plist's StandardOutPath. tee'ing to LOG_FILE on top of that double-writes
# every line. Only tee when stdout is a terminal (interactive standalone run).
log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') [watch] $*"
  if [[ -t 1 ]]; then
    printf '%s\n' "$line" | tee -a "$LOG_FILE"
  else
    printf '%s\n' "$line"
  fi
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

  # _hq/ special folder convention: any file under a path component named
  # "_hq" gets encoded at higher quality (CRF 22 vs default 26). Output is
  # ~30-50% larger but visibly better — for archival sources or content
  # where compression artifacts would matter. Match anywhere in the path.
  local crf="${DEFAULT_CRF:-26}"
  case "$in" in
    */_hq/*) crf="${HQ_CRF:-22}"; log "stable, processing (HQ crf=$crf) $in" ;;
    *)       log "stable, processing $in" ;;
  esac

  if ! bash "$COMPRESS" --threshold "$THRESHOLD" --crf "$crf" "$in" 2>>"$LOG_FILE"; then
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
      # Mirror the source's relative path under WATCH_DIR into DONE_DIR so
      # the original folder structure is preserved (and idempotent re-scans
      # don't re-pick-up files in done/).
      local rel="${result#${WATCH_DIR%/}/}"
      local target="$DONE_DIR/$rel"
      local target_dir; target_dir="$(dirname "$target")"
      mkdir -p "$target_dir"
      if mv -f "$result" "$target"; then
        log "moved -> $target"
      else
        log "ERROR move-to-done failed for $result"
      fi
    fi
  fi
}

# --- Main: scan once, exit -------------------------------------------------
log "trigger fired, scanning $WATCH_DIR (recursive)"

# Recursive walk. -prune skips the entire done/ subtree without descending
# into it (cheaper than -not -path on large done/ folders).
while IFS= read -r -d '' f; do
  handle "$f"
done < <(find "$WATCH_DIR" \
  -path "$DONE_DIR" -prune -o \
  -type f \( \
    -iname '*.mp4' -o -iname '*.mov' -o -iname '*.avi' -o \
    -iname '*.mkv' -o -iname '*.m4v' -o -iname '*.webm' \
  \) -print0)

log "scan complete"
