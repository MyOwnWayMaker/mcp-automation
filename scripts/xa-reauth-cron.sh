#!/bin/bash
# Wrapper for the scheduled XA re-auth. Sources zsh env so RAILWAY_API_TOKEN
# (which the auth script needs to push the refreshed session to Railway)
# is in scope, then runs auth-xactanalysis.mjs from the repo root.
# Notifies via ntfy on start, success, failure.
#
# Invoked by ~/Library/LaunchAgents/com.hakiel.xa-reauth.plist on a 5-day interval.

set -u
REPO="/Users/dino/mcp-automation"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/xa-reauth-$(date +%Y%m%d-%H%M%S).log"
NTFY_TOPIC="hakiel-mac-mini-xa-reauth"

# Source ~/.zshrc to pick up RAILWAY_API_TOKEN, PATH adjustments, etc.
# .zshrc currently exports RAILWAY_API_TOKEN — that's the one the script needs
# for the post-auth Railway env-var push via GraphQL.
# shellcheck disable=SC1090
source ~/.zshrc >/dev/null 2>&1 || true

cd "$REPO" || exit 1

notify() {
  curl -s -X POST "https://ntfy.sh/${NTFY_TOPIC}" \
    -H "Title: ${1}" \
    -d "${2:-}" >/dev/null 2>&1 || true
}

{
  echo "=== $(date) — scheduled XA re-auth starting ==="
  echo "Repo:    $REPO"
  echo "Node:    $(/opt/homebrew/bin/node --version 2>&1 || node --version)"
  echo "Token:   ${RAILWAY_API_TOKEN:+set} ${RAILWAY_API_TOKEN:-MISSING}"
} >> "$LOG" 2>&1

notify "[XA re-auth] starting" "Logs at $LOG"

# Persistent Chromium profile holding Verisk's device-trust cookie. Once the
# device is trusted (bootstrapped with one OTP), this unattended run skips MFA
# and completes with NO OTP. Stable home-dir path so it's shared across runs.
export XA_CHROME_PROFILE_DIR="$HOME/.xa-userdata"
# Headful left ON (XA_HEADLESS unset): Incapsula/Imperva is friendlier to a real
# window + returning profile, and launchd agents run in the logged-in GUI session.

# Run the auth script with SKIP_RAILWAY_PUSH so it does NOT call the multi-var
# helper (which can clobber Voice/Notary/FileTrac with stale local files). It
# just writes xactanalysis_session.json locally; we push only the XA var below.
export SKIP_RAILWAY_PUSH=1
/opt/homebrew/bin/node "$REPO/scripts/auth-xactanalysis.mjs" >> "$LOG" 2>&1
rc=$?

# On a successful re-auth, push ONLY XACTANALYSIS_SESSION_JSON (single-var,
# never the 4-var clobber). Failure to push downgrades success to failure.
if [ "$rc" -eq 0 ]; then
  /opt/homebrew/bin/node "$REPO/scripts/push-xa-session.mjs" >> "$LOG" 2>&1 || rc=$?
fi

if [ "$rc" -eq 0 ]; then
  echo "=== $(date) — re-auth SUCCESS ===" >> "$LOG"
  notify "[XA re-auth] ✅ success" "Session refreshed and pushed to Railway"
else
  echo "=== $(date) — re-auth FAILED exit=$rc ===" >> "$LOG"
  tail -50 "$LOG" >> "$LOG_DIR/xa-reauth-failures.log"
  notify "[XA re-auth] ❌ FAILED exit=$rc" "Check $LOG. Possible cause: OTP timeout (no code written to /tmp/xactanalysis-otp.txt within 5 min), browser auth flow failure, or Railway push error."
fi

exit "$rc"
