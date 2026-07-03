// send-scheduled-sms-20260624.mjs — one-shot: send the two approved first-contact
// texts (Johnnie Ausbon + Sybil Davis), arm the 2-hour no-reply watchdog, ntfy.
// Texts + times were APPROVED by Hakiel 2026-06-24 ~04:35 PT for a 7:03 AM send.
// Furthest-from-home first (Johnnie/South), then Sybil/Central on the way back.
import { spawnSync } from "node:child_process";
import { voiceSendSms } from "../dist/tools/voice.js";

const REPO = "/Users/dino/mcp-automation";
const NTFY = "hakiel-mac-mini-claim-pipeline";

const RECIPIENTS = [
  {
    label: "Johnnie Ausbon",
    number: "+13238154543",
    thread: "t.+13238154543",
    claim: "81031769",
    window: "7am-8am",
    body: "Hello Johnnie. This is a courtesy text from your field adjuster, Hakiel McQueen.\n\nI'm texting to conveniently schedule an inspection for the recent damages to your property.\n\nThe next opening I have is Thursday June 25th between 7am-8am. Can you be available at this time?",
  },
  {
    label: "Sybil Davis",
    number: "+18184228156",
    thread: "t.+18184228156",
    claim: "81031771",
    window: "10am-11am",
    body: "Hello Sybil. This is a courtesy text from your field adjuster, Hakiel McQueen.\n\nI'm texting to conveniently schedule an inspection for the recent damages to your property.\n\nThe next opening I have is Thursday June 25th between 10am-11am. Can you be available at this time?",
  },
];

async function ntfy(title, msg) {
  try {
    await fetch(`https://ntfy.sh/${NTFY}`, { method: "POST", headers: { Title: title }, body: msg });
  } catch {}
}

const results = [];
for (const r of RECIPIENTS) {
  const sendIso = new Date().toISOString();
  let ok = false, detail = "";
  try {
    const res = await voiceSendSms({ number: r.number, body: r.body });
    detail = res?.content?.[0]?.text ?? "";
    // Treat as success unless the tool explicitly reports a failure — avoids a
    // false-negative that would prompt a duplicate resend to the insured.
    ok = detail.length > 0 && !res?.isError && !/fail|error|not sent|could not|unable|sign in|logged out/i.test(detail);
  } catch (e) {
    detail = String(e?.message ?? e).slice(0, 200);
  }
  results.push({ label: r.label, number: r.number, ok, detail: detail.slice(0, 160) });
  console.log(`[${r.label}] ${r.number} -> ${ok ? "SENT" : "FAIL"}: ${detail.slice(0, 160)}`);

  if (ok) {
    // Arm the 2-hour no-reply watchdog (sms-monitor picks it up from the tracker).
    const reg = spawnSync("node", [
      `${REPO}/scripts/sms-register-pending.mjs`,
      "--thread", r.thread,
      "--contact", r.label,
      "--claim", r.claim,
      "--company-index", "1",
      "--ia-firm", "PCAS",
      "--send-iso", sendIso,
      "--proposed-date", "2026-06-25",
      "--window", r.window,
    ], { encoding: "utf8" });
    console.log(`  watchdog register: ${reg.status === 0 ? "ok" : "FAILED " + (reg.stderr || "").slice(0, 160)}`);
  }
}

const sent = results.filter(r => r.ok).map(r => r.label);
const failed = results.filter(r => !r.ok).map(r => `${r.label} (${r.detail})`);
let summary = "";
if (sent.length) summary += `✅ Sent inspection texts: ${sent.join("; ")}`;
if (failed.length) summary += `${summary ? " | " : ""}❌ FAILED: ${failed.join("; ")}`;
await ntfy("[claim-pipeline] inspection texts", summary || "no recipients");
console.log("SUMMARY:", summary);

process.exit(failed.length ? 1 : 0);
