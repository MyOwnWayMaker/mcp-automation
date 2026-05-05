import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { voiceGetThread } from "./voice.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const DEFAULT_NTFY_TOPIC = "dino-claims-alerts-fpx";

function asciiSafe(s: string | undefined): string {
  return (s || "").replace(/[^\x00-\x7F]/g, "").trim();
}

function unwrap(r: CallToolResult): any {
  const c0 = r.content?.[0];
  const text = c0 && c0.type === "text" ? c0.text : "";
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

export type CheckFollowupArgs = {
  // Voice thread identifier — accept either form, mirroring voice_get_thread.
  thread_id?: string;
  insured_phone?: string;        // accepted as `contact` for voice_get_thread
  // The instant our outbound SMS was sent (ISO datetime). Inbound messages
  // with timestamp >= this count as a reply.
  sent_at: string;
  // For alert content
  insured_name: string;
  // Threshold below which we don't fire the follow-up even if no reply has
  // arrived (default 3 hours per playbook step 9).
  threshold_hours?: number;
  // Force fire even if before threshold (for testing).
  force_fire?: boolean;
  // ntfy overrides
  ntfy_topic?: string;
  ntfy_server?: string;
};

export type InboundReply = {
  timestamp_iso: string;
  sender?: string;
  body: string;
};

export type CheckFollowupResult =
  | {
      ok: true;
      replied: boolean;
      reply?: InboundReply;            // first inbound reply found after sent_at
      voice_check_failed?: string;     // populated if voice_get_thread errored (auth, network); we proceed assuming no reply
      hours_since_sent: number;
      threshold_hours: number;
      followup_fired: boolean;
      ntfy_url?: string;
    }
  | { ok: false; error: string };

/**
 * Step 9 of the post-claim playbook (D3). Checks whether the POC has
 * replied to our outbound SMS since `sent_at`. If no reply AND we're past
 * `threshold_hours` (default 3), fire an ntfy `[FOLLOWUP]` alert telling
 * Hakiel to call the POC manually.
 *
 * **Hard rule:** NEVER auto-resends the SMS. Re-engagement must be a
 * manual call from Hakiel. This is a hard playbook constraint — fixing the
 * POC's silence with a duplicate text would feel spammy and would also
 * cost us approval discipline.
 *
 * Single-shot tool — Cloud Dispatch (or a cron) calls it on a schedule.
 * Idempotent: calling repeatedly will fire the alert each time, so the
 * caller is responsible for "fire once per claim" gating.
 */
export async function checkFollowupDue(args: CheckFollowupArgs): Promise<CheckFollowupResult> {
  if (!args.thread_id && !args.insured_phone) {
    return { ok: false, error: "thread_id or insured_phone required" };
  }
  const sentAtMs = Date.parse(args.sent_at);
  if (isNaN(sentAtMs)) return { ok: false, error: `bad sent_at: ${args.sent_at}` };

  const threshold = args.threshold_hours ?? 3;
  const nowMs = Date.now();
  const hoursSinceSent = (nowMs - sentAtMs) / 3_600_000;

  // 1. Read the thread. If this fails (Voice session expired, auth, network),
  // we err on the side of firing the follow-up — better Hakiel makes a
  // false-positive call than the POC sits silent. Voice check failure is
  // surfaced in the result so the caller can repair it.
  let messages: any[] = [];
  let voiceCheckFailed: string | undefined;
  try {
    const threadRes = await voiceGetThread({
      thread_id: args.thread_id,
      contact: args.thread_id ? undefined : args.insured_phone,
      order: "newest_first",
      max_messages: 50,
    });
    const threadData = unwrap(threadRes);
    if (threadData._raw && !threadData.messages) {
      voiceCheckFailed = threadData._raw.slice(0, 300);
    } else {
      messages = threadData.messages ?? [];
    }
  } catch (e: any) {
    voiceCheckFailed = `exception: ${e?.message ?? e}`;
  }

  // 2. Find first inbound message after sent_at.
  let reply: InboundReply | undefined;
  for (const m of messages) {
    if (m.direction !== "inbound") continue;
    if (!m.timestamp_iso) continue;
    const t = Date.parse(m.timestamp_iso);
    if (isNaN(t)) continue;
    if (t < sentAtMs) continue;
    if (!reply || t < Date.parse(reply.timestamp_iso)) {
      reply = {
        timestamp_iso: m.timestamp_iso,
        sender: m.sender,
        body: m.body ?? m.text ?? "",
      };
    }
  }

  const replied = !!reply;
  const dueByThreshold = hoursSinceSent >= threshold;
  const shouldFire = !replied && (dueByThreshold || args.force_fire === true);

  if (!shouldFire) {
    return {
      ok: true,
      replied,
      reply,
      voice_check_failed: voiceCheckFailed,
      hours_since_sent: Math.round(hoursSinceSent * 10) / 10,
      threshold_hours: threshold,
      followup_fired: false,
    };
  }

  // 3. Fire the ntfy [FOLLOWUP] alert.
  const topic = args.ntfy_topic
    || process.env.CLAIM_MONITOR_NTFY_TOPIC
    || DEFAULT_NTFY_TOPIC;
  const server = args.ntfy_server
    || process.env.CLAIM_MONITOR_NTFY_SERVER
    || DEFAULT_NTFY_SERVER;
  const url = `${server}/${encodeURIComponent(topic)}`;

  const fullTitle = `[FOLLOWUP] ${args.insured_name} — call manually`;
  const safeTitle = asciiSafe(fullTitle) || "[FOLLOWUP]";
  const phone = args.insured_phone ? `Phone: ${args.insured_phone}\n` : "";
  const voiceWarning = voiceCheckFailed
    ? `\n⚠️ Voice thread couldn't be polled (${voiceCheckFailed.slice(0, 120)}). Treating as 'no reply' to be safe — confirm visually.\n`
    : "";
  const msgBody =
`${fullTitle}

No reply from ${args.insured_name} since SMS sent at ${args.sent_at}.
${phone}Hours elapsed: ${hoursSinceSent.toFixed(1)} (threshold: ${threshold}h)
${voiceWarning}
Reminder: do NOT auto-resend the SMS. Call the POC manually.`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Title": safeTitle,
        "Priority": "5",            // urgent — needs immediate manual action
        "Tags": "phone,warning",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: msgBody,
    });
    if (!res.ok) {
      return { ok: false, error: `ntfy POST failed: HTTP ${res.status} ${res.statusText}` };
    }
  } catch (e: any) {
    return { ok: false, error: `ntfy POST error: ${e?.message ?? e}` };
  }

  return {
    ok: true,
    replied: false,
    voice_check_failed: voiceCheckFailed,
    hours_since_sent: Math.round(hoursSinceSent * 10) / 10,
    threshold_hours: threshold,
    followup_fired: true,
    ntfy_url: url,
  };
}

export async function checkFollowupDueTool(args: CheckFollowupArgs): Promise<CallToolResult> {
  const result = await checkFollowupDue(args);
  return ok(JSON.stringify(result, null, 2));
}
