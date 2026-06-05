/**
 * XactAnalysis session keepalive probe.
 *
 * The XA session uses a sliding-window idle TTL (~7-10 days). The 2026-05-25
 * volume fix prevents redeploy-induced loss, but quiet stretches (weekends,
 * slow weeks) still let the session idle-expire well before the 30-day hard
 * ceiling. This watcher pokes XA on a 12-hour cadence with the cheapest
 * authenticated request available (list_assignments, limit=1) to keep the
 * sliding timer warm.
 *
 * On 2 consecutive failures, fires a ntfy alert to the re-auth topic so Hakiel
 * knows to re-auth before the next claim arrives. Single failures are
 * swallowed silently to avoid noise on transient network blips.
 *
 * Disable via env: XA_KEEPALIVE_DISABLED=1.
 */

import { xactListAssignments } from "../tools/xactanalysis.js";

const PROBE_MS = 12 * 60 * 60 * 1000; // every 12h
const NTFY_TOPIC = process.env.XA_KEEPALIVE_NTFY_TOPIC || "hakiel-mac-mini-xa-reauth";

let started = false;
let consecutiveFailures = 0;
let lastProbeAt: string | null = null;
let lastResult: "ok" | "fail" | null = null;

async function probe(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    await xactListAssignments({ max_results: 1 });
    consecutiveFailures = 0;
    lastResult = "ok";
    lastProbeAt = startedAt;
    console.log(`[xa-keepalive] ✅ probe ok at ${startedAt}`);
  } catch (err: any) {
    consecutiveFailures++;
    lastResult = "fail";
    lastProbeAt = startedAt;
    const msg = err?.message ?? String(err);
    console.error(`[xa-keepalive] ❌ probe failed (#${consecutiveFailures}) at ${startedAt}: ${msg}`);
    if (consecutiveFailures >= 2) {
      try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: "POST",
          headers: {
            "Title": "XA keepalive failed — session may need re-auth",
            "Priority": "high",
            "Tags": "warning",
          },
          body:
            `[${startedAt}] xa-keepalive failed ${consecutiveFailures}x in a row.\n\n` +
            `Last error: ${msg}\n\n` +
            `Run: node scripts/auth-xactanalysis.mjs (send OTP via chat).`,
        });
      } catch (_) { /* ntfy network failure — swallow */ }
    }
  }
}

export function getXaKeepaliveHealth(): {
  running: boolean;
  disabled: boolean;
  lastProbeAt: string | null;
  lastResult: "ok" | "fail" | null;
  consecutiveFailures: number;
} {
  return {
    running: started,
    disabled: process.env.XA_KEEPALIVE_DISABLED === "1",
    lastProbeAt,
    lastResult,
    consecutiveFailures,
  };
}

export function startXaKeepalive(): void {
  if (process.env.XA_KEEPALIVE_DISABLED === "1") {
    console.log("[xa-keepalive] disabled via XA_KEEPALIVE_DISABLED=1");
    return;
  }
  if (started) return;
  started = true;
  // First probe after 60s so server can finish settling on cold boot, then every 12h.
  setTimeout(() => {
    probe().catch(() => { /* swallow */ });
    setInterval(() => { probe().catch(() => { /* swallow */ }); }, PROBE_MS);
  }, 60_000);
  console.log(`[xa-keepalive] started — first probe in 60s, then every ${PROBE_MS / 1000 / 3600}h`);
}
