/**
 * Follow-up scheduler (queue #6 / D3 tail).
 *
 * `checkFollowupDue` (src/tools/followup_check.ts) is a single-shot checker and
 * explicitly does NOT gate "fire once per claim" — its docstring puts that on
 * the caller. Nothing owned that responsibility, so the 3hr no-reply follow-up
 * never ran autonomously. This scheduler is that owner.
 *
 * Design mirrors claim_monitor's in-memory state convention: a Map registry +
 * a setInterval poller. State is in-memory by the same deliberate trade-off the
 * claim watcher documents — a Railway redeploy loses pending follow-ups. That's
 * acceptable for a 3hr window (worst case: a follow-up that was due near a
 * redeploy is missed, which is no worse than today where none fire at all). If
 * durability is wanted later, persist the registry to the Railway volume or a
 * Notion row — flagged, not built.
 *
 * Disable via env: FOLLOWUP_SCHEDULER_DISABLED=1.
 */

import { checkFollowupDue } from "../tools/followup_check.js";

type FollowupEntry = {
  key: string;
  insured_name: string;
  insured_phone?: string;
  thread_id?: string;
  sent_at: string;        // ISO — when our outbound SMS went
  threshold_hours: number;
  registered_at: number;  // ms — for the stale sweep
};

const registry = new Map<string, FollowupEntry>();
let schedulerStarted = false;

const POLL_MS = 5 * 60 * 1000;         // re-check pending follow-ups every 5 min
const STALE_MS = 24 * 60 * 60 * 1000;  // hard-drop anything tracked >24h

/**
 * Register a no-reply follow-up. Called right after a confirmed outbound SMS.
 * Re-registering the same key (e.g. a re-send) overwrites with the newer sent_at.
 */
export function scheduleFollowup(entry: {
  key: string;
  insured_name: string;
  insured_phone?: string;
  thread_id?: string;
  sent_at: string;
  threshold_hours?: number;
}): void {
  if (process.env.FOLLOWUP_SCHEDULER_DISABLED === "1") return;
  if (!entry.thread_id && !entry.insured_phone) {
    console.error(`[followup-scheduler] cannot schedule ${entry.key}: no thread_id or phone`);
    return;
  }
  registry.set(entry.key, {
    key: entry.key,
    insured_name: entry.insured_name,
    insured_phone: entry.insured_phone,
    thread_id: entry.thread_id,
    sent_at: entry.sent_at,
    threshold_hours: entry.threshold_hours ?? 3,
    registered_at: Date.now(),
  });
  console.log(`[followup-scheduler] armed follow-up for ${entry.key} (${registry.size} pending)`);
}

export function getPendingFollowupCount(): number {
  return registry.size;
}

async function poll(): Promise<void> {
  if (registry.size === 0) return;
  for (const [key, e] of [...registry.entries()]) {
    // Stale sweep first — never let the registry grow unbounded if a check
    // keeps soft-failing (e.g. Voice session expired for a whole day).
    if (Date.now() - e.registered_at > STALE_MS) {
      registry.delete(key);
      console.log(`[followup-scheduler] dropped stale entry ${key}`);
      continue;
    }
    try {
      const r = await checkFollowupDue({
        thread_id: e.thread_id,
        insured_phone: e.insured_phone,
        sent_at: e.sent_at,
        insured_name: e.insured_name,
        threshold_hours: e.threshold_hours,
      });
      // Terminal states: the POC replied (no follow-up needed) OR we fired the
      // [FOLLOWUP] alert. Remove either way so we never double-fire — this is
      // the "fire once per claim" gating checkFollowupDue leaves to the caller.
      if (r.ok && (r.replied || r.followup_fired)) {
        registry.delete(key);
        console.log(`[followup-scheduler] ${key} resolved (replied=${r.replied} fired=${r.followup_fired}); ${registry.size} pending`);
      }
    } catch (err: any) {
      console.error(`[followup-scheduler] poll error for ${key}: ${err?.message ?? err}`);
    }
  }
}

export function startFollowupScheduler(): void {
  if (process.env.FOLLOWUP_SCHEDULER_DISABLED === "1") {
    console.log("[followup-scheduler] disabled via FOLLOWUP_SCHEDULER_DISABLED=1");
    return;
  }
  if (schedulerStarted) return;
  schedulerStarted = true;
  setInterval(() => { poll().catch(() => { /* swallow */ }); }, POLL_MS);
  console.log(`[followup-scheduler] started (poll every ${POLL_MS / 60000}m, 3h default threshold)`);
}
