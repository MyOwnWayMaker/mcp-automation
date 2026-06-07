/**
 * FileTrac session keepalive / health probe.
 *
 * IMPORTANT — this is MONITORING, not renewal. FileTrac's Cognito refresh token
 * has a HARD ~30-day cap (unlike XA's sliding idle-TTL, which a probe genuinely
 * refreshes). Poking FileTrac does NOT extend that cap. Proactive renewal is the
 * job of the launchd cron (scripts/filetrac-reauth-cron.sh), which re-auths
 * zero-code on a ~21-day cadence. This probe's job is to catch an unexpected
 * early death (session pushed stale, manual change, etc.) and alert FAST so the
 * gap before Dispatch trips is minimized.
 *
 * On 2 consecutive failures, fires a ntfy alert to the re-auth topic. Single
 * failures are swallowed to avoid noise on transient blips.
 *
 * Disable via env: FILETRAC_KEEPALIVE_DISABLED=1.
 */

import { filetracListCompanies } from "../tools/filetrac.js";

const PROBE_MS = 12 * 60 * 60 * 1000; // every 12h
const NTFY_TOPIC = process.env.FILETRAC_KEEPALIVE_NTFY_TOPIC || "hakiel-mac-mini-xa-reauth";

let started = false;
let consecutiveFailures = 0;
let lastProbeAt: string | null = null;
let lastResult: "ok" | "fail" | null = null;

// A healthy FileTrac response lists the linked companies; a dead session bounces
// to the ftevolve login page, which surfaces as "Log In" text in the body.
function looksAuthenticated(text: string): boolean {
  if (/Linked Companies|My Jobs/i.test(text)) return true;
  if (/Log In|Email address|Forgot password/i.test(text)) return false;
  return true; // unknown shape → don't false-alarm
}

async function probe(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const res = await filetracListCompanies({});
    const text = (res?.content ?? [])
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
    if (!looksAuthenticated(text)) throw new Error("response looks like the login page (session expired)");
    consecutiveFailures = 0;
    lastResult = "ok";
    lastProbeAt = startedAt;
    console.log(`[filetrac-keepalive] ✅ probe ok at ${startedAt}`);
  } catch (err: any) {
    consecutiveFailures++;
    lastResult = "fail";
    lastProbeAt = startedAt;
    const msg = err?.message ?? String(err);
    console.error(`[filetrac-keepalive] ❌ probe failed (#${consecutiveFailures}) at ${startedAt}: ${msg}`);
    if (consecutiveFailures >= 2) {
      try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: "POST",
          headers: { "Title": "FileTrac keepalive failed — session may need re-auth", "Priority": "high", "Tags": "warning" },
          body:
            `[${startedAt}] filetrac-keepalive failed ${consecutiveFailures}x in a row.\n\n` +
            `Last error: ${msg}\n\n` +
            `Re-auth (zero-code if device still remembered):\n` +
            `  env -u RAILWAY_API_TOKEN railway run node scripts/auth-filetrac-remote.mjs\n` +
            `then push: railway variable set FILETRAC_SESSION_JSON --stdin`,
        });
      } catch (_) { /* ntfy network failure — swallow */ }
    }
  }
}

export function getFiletracKeepaliveHealth(): {
  running: boolean;
  disabled: boolean;
  lastProbeAt: string | null;
  lastResult: "ok" | "fail" | null;
  consecutiveFailures: number;
} {
  return {
    running: started,
    disabled: process.env.FILETRAC_KEEPALIVE_DISABLED === "1",
    lastProbeAt,
    lastResult,
    consecutiveFailures,
  };
}

export function startFiletracKeepalive(): void {
  if (process.env.FILETRAC_KEEPALIVE_DISABLED === "1") {
    console.log("[filetrac-keepalive] disabled via FILETRAC_KEEPALIVE_DISABLED=1");
    return;
  }
  if (started) return;
  started = true;
  // First probe after 90s so the server finishes settling on cold boot, then every 12h.
  setTimeout(() => {
    probe().catch(() => { /* swallow */ });
    setInterval(() => { probe().catch(() => { /* swallow */ }); }, PROBE_MS);
  }, 90_000);
  console.log(`[filetrac-keepalive] started — first probe in 90s, then every ${PROBE_MS / 1000 / 3600}h`);
}
