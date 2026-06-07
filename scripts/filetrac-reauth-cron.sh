#!/bin/bash
# Scheduled FileTrac re-auth — PROACTIVE + ZERO-CODE.
#
# FileTrac's Cognito refresh token has a HARD ~30-day cap (no probe can extend
# it — unlike XA's sliding TTL), so the only way to "keep it alive" is to
# re-authenticate before the cap. This runs auth-filetrac-remote.mjs (headless,
# creds injected from Railway via OAuth) on a ~21-day cadence — comfortably
# inside the 30-day window — then pushes the refreshed session to Railway.
#
# With the persistent device profile (~/.filetrac-userdata) the remembered
# device means NO MFA code is needed → fully unattended. If the device window
# has lapsed, the run waits a few minutes for a code at /tmp/filetrac-mfa.txt;
# if none arrives it fails and ntfys Hakiel to do a manual code-supplied re-auth.
#
# Invoked by ~/Library/LaunchAgents/com.hakiel.filetrac-reauth.plist.

set -u
REPO="/Users/dino/mcp-automation"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/filetrac-reauth-$(date +%Y%m%d-%H%M%S).log"
NTFY_TOPIC="hakiel-mac-mini-xa-reauth"   # shared claim-management re-auth topic

# Source ~/.zshrc for PATH (node, railway) and any env. NOTE: the Railway PAT in
# the env is DEAD and shadows OAuth, so every railway call below strips it with
# `env -u RAILWAY_API_TOKEN -u RAILWAY_TOKEN` to fall back to the working OAuth login.
# shellcheck disable=SC1090
source ~/.zshrc >/dev/null 2>&1 || true
cd "$REPO" || exit 1

notify() {
  curl -s -X POST "https://ntfy.sh/${NTFY_TOPIC}" -H "Title: ${1}" -d "${2:-}" >/dev/null 2>&1 || true
}

{
  echo "=== $(date) — scheduled FileTrac re-auth starting ==="
  echo "Repo: $REPO"
  echo "Node: $(/opt/homebrew/bin/node --version 2>&1 || node --version)"
} >> "$LOG" 2>&1
notify "[FileTrac re-auth] starting" "Logs at $LOG"

# Re-auth — PROACTIVE RENEWAL. FILETRAC_FORCE_FRESH=1 is ESSENTIAL here: it clears
# the live session but keeps the device keys, forcing a fresh sign-in that mints a
# NEW 30-day refresh token (resets the hard cap). WITHOUT it the script would hit
# its already-authenticated path and just re-capture the aging session — the cron
# would fire but never actually renew, and FileTrac would still die at day 30.
# Still zero-code (device remembered). 240s grace if the device window has lapsed
# and a code is supplied to /tmp/filetrac-mfa.txt.
env -u RAILWAY_API_TOKEN -u RAILWAY_TOKEN FILETRAC_FORCE_FRESH=1 FILETRAC_MFA_WAIT=240 \
  /opt/homebrew/bin/node "$REPO/scripts/auth-filetrac-remote.mjs" >> "$LOG" 2>&1 \
  || env -u RAILWAY_API_TOKEN -u RAILWAY_TOKEN FILETRAC_FORCE_FRESH=1 FILETRAC_MFA_WAIT=240 \
       railway run node "$REPO/scripts/auth-filetrac-remote.mjs" >> "$LOG" 2>&1
rc=$?

if [ "$rc" -eq 0 ]; then
  # Push refreshed session to Railway (OAuth CLI via stdin; the GraphQL pusher
  # needs the dead PAT, so it's not usable here).
  node -e "process.stdout.write(JSON.stringify(require('$REPO/filetrac_session.json')))" \
    | env -u RAILWAY_API_TOKEN -u RAILWAY_TOKEN railway variable set FILETRAC_SESSION_JSON --stdin >> "$LOG" 2>&1
  prc=$?
  if [ "$prc" -eq 0 ]; then
    echo "=== $(date) — re-auth + Railway push SUCCESS ===" >> "$LOG"
    notify "[FileTrac re-auth] ✅ success" "Session refreshed (zero-code) and pushed to Railway"
  else
    echo "=== $(date) — re-auth OK but Railway push FAILED rc=$prc ===" >> "$LOG"
    notify "[FileTrac re-auth] ⚠️ push failed" "Re-auth ok but Railway push rc=$prc — check $LOG"
  fi
else
  echo "=== $(date) — re-auth FAILED exit=$rc ===" >> "$LOG"
  tail -40 "$LOG" >> "$LOG_DIR/filetrac-reauth-failures.log"
  notify "[FileTrac re-auth] ❌ FAILED exit=$rc" "Likely the remember-device window lapsed → needs a manual code re-auth. Check $LOG"
fi
exit "$rc"
