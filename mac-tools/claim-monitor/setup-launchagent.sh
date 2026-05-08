#!/usr/bin/env bash
# setup-launchagent.sh - install the claim-monitor LaunchAgent on macOS.
#
# Run from the mcp-automation repo root:
#   cd ~/mcp-automation
#   bash mac-tools/claim-monitor/setup-launchagent.sh
#
# What it does:
#   - Detects repo root (= current dir, must contain scripts/claim-monitor.mjs)
#   - Detects node path via `which node` from interactive shell
#   - Renders the plist by sed-replacing __HOME__, __REPO_ROOT__, __NODE__
#   - Stops any currently-running instance (manual or prior LaunchAgent)
#   - Loads the new LaunchAgent — runs at boot, auto-restarts on crash
#   - Tails the log briefly to confirm startup
#
# Idempotent: safe to re-run.

set -euo pipefail

REPO_ROOT="$(pwd)"
TOOLKIT_DIR="${REPO_ROOT}/mac-tools/claim-monitor"
PLIST_SRC="${TOOLKIT_DIR}/com.hakiel.claim-monitor.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/com.hakiel.claim-monitor.plist"
LABEL="com.hakiel.claim-monitor"
LOG_FILE="${HOME}/Library/Logs/claim-monitor.log"

# ── Sanity checks ──────────────────────────────────────────────────────────
if [[ ! -f "${REPO_ROOT}/scripts/claim-monitor.mjs" ]]; then
  echo "ERROR: scripts/claim-monitor.mjs not found at $REPO_ROOT" >&2
  echo "       Run this from the mcp-automation repo root." >&2
  exit 1
fi
if [[ ! -f "$PLIST_SRC" ]]; then
  echo "ERROR: plist template not found at $PLIST_SRC" >&2
  exit 1
fi
if [[ ! -f "${REPO_ROOT}/credentials.json" ]] && [[ -z "${GOOGLE_CREDENTIALS_JSON:-}" ]]; then
  echo "WARN: credentials.json not at repo root and GOOGLE_CREDENTIALS_JSON not set." >&2
  echo "      claim-monitor.mjs will fail to start without one of these." >&2
fi
if [[ ! -f "${REPO_ROOT}/token.json" ]] && [[ -z "${GOOGLE_TOKEN_JSON:-}" ]]; then
  echo "WARN: token.json not at repo root and GOOGLE_TOKEN_JSON not set." >&2
fi

# ── Locate node ─────────────────────────────────────────────────────────────
# `which node` from an interactive shell picks up the user's actual PATH
# (Homebrew, NVM, asdf, etc.). LaunchAgents run with a minimal PATH so we
# bake the resolved path into the plist directly.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH. Install Node.js, or run this script from a shell where node is available." >&2
  exit 1
fi
echo "==> Using node at: $NODE_BIN"

# ── Stop any running instance ───────────────────────────────────────────────
# Belt-and-suspenders: unload via launchctl AND kill any node process running
# the script directly. The latter catches manual-start instances from before
# the LaunchAgent existed.
if launchctl list | grep -q "$LABEL"; then
  echo "==> Unloading existing LaunchAgent"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi
if pgrep -f "claim-monitor.mjs" >/dev/null 2>&1; then
  echo "==> Killing existing claim-monitor.mjs process(es)"
  pkill -f "claim-monitor.mjs" || true
  sleep 1
fi

# ── Render plist ────────────────────────────────────────────────────────────
mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
echo "==> Rendering plist -> $PLIST_DEST"
sed \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__REPO_ROOT__|${REPO_ROOT}|g" \
  -e "s|__NODE__|${NODE_BIN}|g" \
  "$PLIST_SRC" > "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

# ── Load ────────────────────────────────────────────────────────────────────
echo "==> Loading LaunchAgent"
launchctl load "$PLIST_DEST"

sleep 2

# ── Verify ──────────────────────────────────────────────────────────────────
if launchctl list | grep -q "$LABEL"; then
  echo "==> Loaded. Service status:"
  launchctl list | grep "$LABEL" || true
else
  echo "==> WARN: LaunchAgent didn't appear in launchctl list" >&2
fi

echo
echo "==> Recent log output (will show '=== Claim monitor starting ===' on success):"
echo "    Log file: $LOG_FILE"
echo
sleep 1
if [[ -f "$LOG_FILE" ]]; then
  tail -20 "$LOG_FILE" || true
else
  echo "    (no log yet — check back in a minute with: tail -f $LOG_FILE)"
fi

echo
echo "==> Done. Monitor will now start automatically at every boot and auto-restart on crash."
echo "    Live tail:    tail -f $LOG_FILE"
echo "    Manual stop:  launchctl unload $PLIST_DEST"
echo "    Manual start: launchctl load $PLIST_DEST"
