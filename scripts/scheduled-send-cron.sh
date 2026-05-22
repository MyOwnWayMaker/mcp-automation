#!/bin/bash
# Wrapper for the local Gmail scheduled-send sweep. Gmail has no native
# scheduled send (see commit 37f6516), so this runs the local sweep:
# matured internal-only drafts auto-send via drafts.send; matured external
# drafts are surfaced to ntfy for manual review. Sourced env + repo-root
# Google creds, then runs `node dist/tools/scheduled_send.js`.
#
# Invoked by ~/Library/LaunchAgents/com.hakiel.scheduled-send.plist on a short
# interval (the sweep interval == the worst-case send latency). The sweep is
# idempotent and cheap; running it often is fine.
#
# Notifies via ntfy ONLY when something happened (a send, a surface, or an
# error) — empty ticks stay silent to avoid notification spam.

set -u
REPO="/Users/dino/mcp-automation"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/scheduled-send-$(date +%Y%m%d-%H%M%S).log"
NTFY_TOPIC="hakiel-mac-mini-scheduled-send"
NODE="/opt/homebrew/bin/node"

# Source ~/.zshrc to pick up GMAIL_INTERNAL_DOMAINS and any other env the
# server uses. The worker also dotenv-loads $REPO/.env.
# shellcheck disable=SC1090
source ~/.zshrc >/dev/null 2>&1 || true

cd "$REPO" || exit 1

# google.ts's default credential path is the stale /Users/hakielmcqueen/...,
# so point it at the Mac-mini repo-root creds explicitly (the running MCP
# server gets these another way; the unattended cron must set them itself).
export GOOGLE_CREDENTIALS_PATH="${GOOGLE_CREDENTIALS_PATH:-$REPO/credentials.json}"
export GOOGLE_TOKEN_PATH="${GOOGLE_TOKEN_PATH:-$REPO/token.json}"

notify() {
  curl -s -X POST "https://ntfy.sh/${NTFY_TOPIC}" \
    -H "Title: ${1}" \
    -d "${2:-}" >/dev/null 2>&1 || true
}

WORKER="$REPO/dist/tools/scheduled_send.js"
if [ ! -f "$WORKER" ]; then
  echo "$(date) — MISSING $WORKER. Run 'npm run build' in $REPO." >> "$LOG"
  notify "[scheduled-send] ❌ not built" "dist/tools/scheduled_send.js missing — run npm run build in $REPO"
  exit 3
fi

{
  echo "=== $(date) — scheduled-send sweep starting ==="
  echo "Node: $($NODE --version 2>&1 || node --version)"
} >> "$LOG" 2>&1

# Capture the worker's summary line ("... sent=N surfaced=M ... errors=E").
SUMMARY="$("$NODE" "$WORKER" 2>>"$LOG" | tee -a "$LOG" | grep -m1 'checked=')"
rc=${PIPESTATUS[0]}

# Pull the counters out of the summary line for the notify decision.
get() { echo "$SUMMARY" | grep -oE "$1=[0-9]+" | head -1 | cut -d= -f2; }
SENT="$(get sent)";     SENT="${SENT:-0}"
SURFACED="$(get surfaced)"; SURFACED="${SURFACED:-0}"
ERRORS="$(get errors)"; ERRORS="${ERRORS:-0}"

echo "=== $(date) — sweep done (exit=$rc): ${SUMMARY:-no-summary} ===" >> "$LOG"

if [ "$rc" -ne 0 ] || [ "$ERRORS" -gt 0 ]; then
  tail -40 "$LOG" >> "$LOG_DIR/scheduled-send-failures.log"
  notify "[scheduled-send] ❌ errors=$ERRORS exit=$rc" "${SUMMARY:-see $LOG}"
elif [ "$SENT" -gt 0 ] || [ "$SURFACED" -gt 0 ]; then
  notify "[scheduled-send] ✅ sent=$SENT surfaced=$SURFACED" "${SUMMARY}"
fi
# else: nothing matured — stay silent.

exit "$rc"
