#!/bin/bash
# sms-outbox-cron.sh — launchd wrapper for the approval-gated SMS outbox
# runner (com.hakiel.sms-outbox, every 5 min).
#
# The runner consumes Hakiel's "send/edit/skip" replies from the approvals
# ntfy topic, fires the approved text via Google Voice, writes First Date of
# Contact to FileTrac on verified send (new assignments only), and registers
# the outbound with the reply monitor. It needs:
#   - the Voice session file in the repo cwd (same as sms-monitor),
#   - FILETRAC_SESSION_JSON for the read-before-write First Contact update —
#     hydrated from Railway exactly like claim-pipeline-cron.sh (non-fatal:
#     without it the send still goes out and the date write is flagged).
set -u

REPO="/Users/dino/mcp-automation"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/sms-outbox.log"
NTFY_TOPIC="${CLAIM_APPROVALS_NTFY_TOPIC:-hakiel-claim-approvals}"

# shellcheck disable=SC1090
source ~/.zshrc >/dev/null 2>&1 || true

notify() {
  curl -s -H "Title: $1" -H "Priority: high" -H "Tags: rotating_light" \
    -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

if [ -z "${FILETRAC_SESSION_JSON:-}" ] && [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  FT_JSON="$(/opt/homebrew/bin/node "$REPO/scripts/fetch-railway-var.mjs" FILETRAC_SESSION_JSON 2>>"$LOG")"
  if [ -n "$FT_JSON" ]; then
    export FILETRAC_SESSION_JSON="$FT_JSON"
  else
    echo "$(date) WARN: could not hydrate FILETRAC_SESSION_JSON" >> "$LOG"
  fi
fi

cd "$REPO" || exit 1
echo "=== $(date) sms-outbox run ===" >> "$LOG"
/opt/homebrew/bin/node "$REPO/scripts/sms-outbox-runner.mjs" >> "$LOG" 2>&1
rc=$?

if [ "$rc" -ne 0 ]; then
  notify "[sms-outbox] runner FAILED exit=$rc" "$(tail -8 "$LOG")"
  exit "$rc"
fi
