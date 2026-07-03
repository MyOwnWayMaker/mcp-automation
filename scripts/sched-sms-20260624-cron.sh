#!/bin/bash
# sched-sms-20260624-cron.sh — one-shot wrapper that fires the two APPROVED
# first-contact inspection texts (Johnnie Ausbon + Sybil Davis) at 7:03 AM PT
# 2026-06-24, arms the watchdog, then self-destructs (unloads + removes its
# launchd plist) so it never fires again. Marker guards against double-send.
set -u
REPO="/Users/dino/mcp-automation"
LABEL="com.hakiel.sched-sms-davis-ausbon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MARKER="$REPO/data/.sent-davis-ausbon-20260624"
LOG="$REPO/logs/sched-sms-20260624.log"

source ~/.zshrc >/dev/null 2>&1 || true
cd "$REPO" || exit 1
export VOICE_SESSION_PATH="$REPO/voice_session.json"

selfdestruct() { ( sleep 3; launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$PLIST" ) & }

echo "=== $(date) sched-sms run ===" >> "$LOG" 2>&1

if [ -f "$MARKER" ]; then
  echo "already sent (marker present) — self-destructing, no resend" >> "$LOG"
  selfdestruct
  exit 0
fi

/opt/homebrew/bin/node "$REPO/scripts/send-scheduled-sms-20260624.mjs" >> "$LOG" 2>&1
rc=$?
echo "send exit=$rc" >> "$LOG"
# Mark sent on success so a re-fire never double-texts the insureds.
[ "$rc" -eq 0 ] && touch "$MARKER"
# One-shot: remove the job whether it succeeded or failed (failure is ntfy'd).
selfdestruct
exit "$rc"
