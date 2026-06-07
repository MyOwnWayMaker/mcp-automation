#!/usr/bin/env node
/**
 * Claim-stack health check — catches portal-auth outages FAST.
 *
 * WHY THIS EXISTS: the in-server keepalive probes (xaKeepalive/filetracKeepalive)
 * only MONITOR; they can't revive an expired session, and they ntfy only after 2
 * consecutive fails (~24h for XA's 12h probe). XactAnalysis kept silently expiring
 * and sitting dead until Dispatch tripped over it. This runs on a tighter cadence
 * (launchd, default every 3h), reads PRODUCTION truth, and alerts on the FIRST
 * failure — so a re-auth (which needs Hakiel's OTP) happens same-day, not days late.
 *
 * Checks:
 *   1. Server /healthz            — status + uptime
 *   2. XA keepalive (production)  — lastResult must not be "fail"
 *   3. FileTrac keepalive (prod)  — lastResult must not be "fail"
 *   4. Claim monitor (prod)       — running
 *   5. Voice read (local)         — voiceListThreads proves the Voice session is alive
 *   6. Voicemail (local)          — voiceGetVoicemails (currently a STUB; reported, not failed)
 *   7. Test SMS (throttled)       — small SMS to Hakiel's cell; opt-in + max ~1/day
 *
 * Exit 0 = all green (skips/stubs ok); exit 1 = at least one hard failure (also ntfys).
 *
 * Env:
 *   HEALTHZ_URL                 default https://mcp-automation-production.up.railway.app/healthz
 *   HEALTHCHECK_NTFY_TOPIC      default hakiel-mac-mini-xa-reauth
 *   SEND_TEST_SMS=1             enable the test SMS (else skipped)
 *   HEALTHCHECK_SMS_NUMBER      default +16463457705 (Hakiel's cell)
 *   HEALTHCHECK_SMS_STAMP       default /tmp/healthcheck-last-sms.txt (throttle marker)
 *   HEALTHCHECK_SMS_MIN_HOURS   default 20 (min hours between test SMS)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEALTHZ = process.env.HEALTHZ_URL || "https://mcp-automation-production.up.railway.app/healthz";
const NTFY_TOPIC = process.env.HEALTHCHECK_NTFY_TOPIC || "hakiel-mac-mini-xa-reauth";
const SMS_NUMBER = process.env.HEALTHCHECK_SMS_NUMBER || "+16463457705";
const SEND_SMS = process.env.SEND_TEST_SMS === "1";
const SMS_STAMP = process.env.HEALTHCHECK_SMS_STAMP || "/tmp/healthcheck-last-sms.txt";
const SMS_MIN_MS = (parseInt(process.env.HEALTHCHECK_SMS_MIN_HOURS || "20", 10)) * 3600 * 1000;

const results = [];
function rec(name, status, detail) {
  // status: true (pass) | false (fail) | "skip" | "stub"
  results.push({ name, status, detail });
  const icon = status === true ? "✅" : status === false ? "❌" : status === "stub" ? "🟡" : "⏭️";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function checkHealthz() {
  try {
    const r = await fetch(HEALTHZ, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    rec("server /healthz", j.status === "ok" || r.ok, `status=${j.status} uptime=${j.uptimeSec}s`);
    const xa = j.xaKeepalive || {};
    rec("XA keepalive (prod)", xa.lastResult !== "fail", `lastResult=${xa.lastResult} fails=${xa.consecutiveFailures}`);
    const ft = j.filetracKeepalive || {};
    rec("FileTrac keepalive (prod)", ft.lastResult !== "fail", `lastResult=${ft.lastResult} fails=${ft.consecutiveFailures}`);
    const cm = j.claimMonitor || {};
    rec("Claim monitor (prod)", cm.running !== false, `running=${cm.running}`);
    return j;
  } catch (e) {
    rec("server /healthz", false, e.message);
    return null;
  }
}

async function loadVoice() {
  const p = path.join(REPO, "dist/tools/voice.js");
  if (!fs.existsSync(p)) throw new Error("dist/tools/voice.js missing — run `npm run build`");
  return import(p);
}

async function checkVoiceRead() {
  try {
    const { voiceListThreads } = await loadVoice();
    const res = await voiceListThreads({ limit: 1 });
    const text = (res?.content || []).map((c) => c.text || "").join("\n");
    const loggedOut = /log ?in|sign ?in to your google account/i.test(text);
    rec("Voice read (threads)", text.length > 0 && !loggedOut, loggedOut ? "looks logged out" : `inbox ok (${text.length}b)`);
  } catch (e) {
    rec("Voice read (threads)", false, e.message);
  }
}

async function checkVoicemail() {
  try {
    const { voiceGetVoicemails } = await loadVoice();
    const res = await voiceGetVoicemails({ limit: 1 });
    const text = (res?.content || []).map((c) => c.text || "").join("\n");
    if (/not yet implemented|stub/i.test(text)) {
      rec("Voicemail read", "stub", "voice_get_voicemails is a STUB — not implemented yet");
    } else {
      rec("Voicemail read", true, `returned ${text.length}b`);
    }
  } catch (e) {
    rec("Voicemail read", false, e.message);
  }
}

async function checkSms() {
  if (!SEND_SMS) { rec("Test SMS", "skip", "SEND_TEST_SMS!=1 (opt-in)"); return; }
  try {
    if (fs.existsSync(SMS_STAMP)) {
      const last = parseInt(fs.readFileSync(SMS_STAMP, "utf8").trim(), 10) || 0;
      const ageH = ((Date.now() - last) / 3600000).toFixed(1);
      if (Date.now() - last < SMS_MIN_MS) { rec("Test SMS", "skip", `throttled (${ageH}h since last, min ${SMS_MIN_MS / 3600000}h)`); return; }
    }
  } catch { /* ignore stamp errors */ }
  try {
    const { voiceSendSms } = await loadVoice();
    const body = `claim-stack healthcheck OK ${new Date().toISOString()}`;
    const res = await voiceSendSms({ number: SMS_NUMBER, body });
    const text = (res?.content || []).map((c) => c.text || "").join("\n");
    let parsed = {}; try { parsed = JSON.parse(text); } catch { /* non-json */ }
    const sent = parsed.ok === true || parsed.verified === true;
    rec("Test SMS", sent, sent ? `sent+verified to ${SMS_NUMBER}` : `failed: ${(parsed.error || text).slice(0, 140)}`);
    if (sent) { try { fs.writeFileSync(SMS_STAMP, String(Date.now())); } catch {} }
  } catch (e) {
    rec("Test SMS", false, e.message);
  }
}

async function ntfy(title, body) {
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "warning" },
      body,
    });
  } catch { /* swallow */ }
}

(async () => {
  console.log(`=== claim-stack healthcheck ${new Date().toISOString()} ===`);
  await checkHealthz();
  await checkVoiceRead();
  await checkVoicemail();
  await checkSms();

  const fails = results.filter((r) => r.status === false);
  const stubs = results.filter((r) => r.status === "stub");
  console.log(`\nSummary: ${results.filter((r) => r.status === true).length} pass, ${fails.length} FAIL, ${stubs.length} stub, ${results.filter((r) => r.status === "skip").length} skip`);

  if (fails.length) {
    const lines = fails.map((f) => `❌ ${f.name}: ${f.detail || ""}`).join("\n");
    console.log(`\nFAILURES:\n${lines}`);
    await ntfy(`[claim-stack] ${fails.length} check(s) FAILED`,
      `${lines}\n\nIf XA failed: re-auth (needs SMS OTP):\n  env -u RAILWAY_API_TOKEN SKIP_RAILWAY_PUSH=1 railway run node scripts/auth-xactanalysis.mjs\nthen push XACTANALYSIS_SESSION_JSON via railway variable set --stdin.`);
    process.exit(1);
  }
  process.exit(0);
})();
