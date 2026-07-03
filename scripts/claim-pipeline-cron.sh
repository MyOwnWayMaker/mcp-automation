#!/bin/bash
# claim-pipeline-cron.sh — scheduled new-assignment pipeline (B2).
# Invoked by ~/Library/LaunchAgents/com.hakiel.claim-pipeline.plist every 15 min.
# Scans Gmail for new assignments/supplements, files Drive folders + mirrors to
# Queststar (idempotent: data/pipeline_state.json dedups), and ntfys a summary
# whenever something was filed OR a detected assignment couldn't be auto-filed
# (incomplete fields) — so detections are NEVER silent (Carol-Gross lesson).
set -u
REPO="/Users/dino/mcp-automation"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/claim-pipeline-$TS.log"
OUT="$LOG_DIR/claim-pipeline-$TS.json"
NTFY_TOPIC="hakiel-mac-mini-claim-pipeline"

# shellcheck disable=SC1090
source ~/.zshrc >/dev/null 2>&1 || true
cd "$REPO" || exit 1

notify() {
  curl -s -X POST "https://ntfy.sh/${NTFY_TOPIC}" -H "Title: ${1}" -d "${2:-}" >/dev/null 2>&1 || true
}

{
  echo "=== $(date) — claim-pipeline run $TS ==="
  echo "Node: $(/opt/homebrew/bin/node --version 2>&1)"
} >> "$LOG" 2>&1

# Hydrate the FileTrac session from Railway (single source of truth — the 5-day
# FileTrac re-auth pushes its refreshed blob there). The local cron has no
# FileTrac session of its own, so PCAS/USCS assignments forwarded as free-text
# (real data only in FileTrac) can't be auto-filed without this. Self-healing:
# always uses whatever the last re-auth pushed, so the job never runs on a stale
# snapshot. Non-fatal — if the fetch fails, the pipeline still files SLG/XA-side
# claims and flags PCAS forwards as INCOMPLETE for retry.
if [ -z "${FILETRAC_SESSION_JSON:-}" ] && [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  FT_JSON="$(/opt/homebrew/bin/node "$REPO/scripts/fetch-railway-var.mjs" FILETRAC_SESSION_JSON 2>>"$LOG")"
  if [ -n "$FT_JSON" ]; then
    export FILETRAC_SESSION_JSON="$FT_JSON"
    echo "FileTrac session hydrated from Railway (${#FT_JSON} bytes)." >> "$LOG"
  else
    echo "WARN: could not hydrate FILETRAC_SESSION_JSON from Railway." >> "$LOG"
  fi
fi

/opt/homebrew/bin/node "$REPO/scripts/process-new-mail.mjs" --since-days 7 --max 25 > "$OUT" 2>> "$LOG"
rc=$?

if [ "$rc" -ne 0 ]; then
  echo "=== $(date) — FAILED exit=$rc ===" >> "$LOG"
  tail -40 "$LOG" >> "$LOG_DIR/claim-pipeline-failures.log"
  notify "[claim-pipeline] ❌ FAILED exit=$rc" "$(tail -8 "$LOG")"
  exit "$rc"
fi

# Build a human summary from the JSON result; only ntfy when noteworthy.
SUMMARY=$(/opt/homebrew/bin/node -e '
const fs=require("fs");
let d=[]; try{ d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log("__parse_error__"); process.exit(0); }
if(!Array.isArray(d)) d=[d];
const acts=d.filter(x=>x&&x.action);
const inc=d.filter(x=>x&&x.skipped==="incomplete-fields-for-new-assignment");
const fterr=d.filter(x=>x&&x.skipped==="ft-backfill-error");
const errs=d.filter(x=>x&&x.error);
const L=[];
if(acts.length) L.push("✅ Filed "+acts.length+": "+acts.map(a=>(a.folder&&a.folder.name)||a.action).join("; "));
if(inc.length) L.push("⚠️ INCOMPLETE "+inc.length+" (needs attention): "+inc.map(a=>((a.detail&&a.detail.insured)||a.messageId)).join("; "));
if(fterr.length) L.push("⚠️ FileTrac unreachable "+fterr.length+" (held for retry)");
if(errs.length) L.push("❌ Errors "+errs.length);
console.log(L.join(" | "));
' "$OUT")

echo "summary: $SUMMARY" >> "$LOG"

if [ "$SUMMARY" = "__parse_error__" ]; then
  notify "[claim-pipeline] ⚠️ output parse error" "Check $OUT"
elif [ -n "$SUMMARY" ]; then
  notify "[claim-pipeline] activity" "$SUMMARY"
fi
# (no notify when nothing actionable — avoids 15-min noise)
exit 0
