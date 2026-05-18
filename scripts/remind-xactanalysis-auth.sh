#!/bin/bash
# Sends Hakiel an iMessage reminding him to re-auth XactAnalysis.
# Triggered by launchd every 6 days.

osascript <<'EOF'
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "+14244663685" of targetService
  send "XactAnalysis session expires soon. In Terminal: cd ~/mcp-automation  then:  railway run node scripts/auth-xactanalysis.mjs" to targetBuddy
end tell
EOF
