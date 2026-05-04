import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const DEFAULT_NTFY_TOPIC = "dino-claims-alerts-fpx";

// HTTP headers must be ASCII. Strip emoji and other non-ASCII from anything
// going into a header (Title, Tags) — they go fine in the message body.
function asciiSafe(s: string | undefined): string {
  return (s || "").replace(/[^\x00-\x7F]/g, "").trim();
}

export type ApprovalSlot = {
  // From pick_inspection_slots — minimal shape we actually use.
  date: string;          // YYYY-MM-DD
  weekday?: string;
  start_label: string;   // "11:00 AM"
  end_label: string;     // "12:00 PM"
  rationale: string;     // "adjacent_after" | "adjacent_before" | "earliest_free"
  feasible?: boolean;
  infeasible_reason?: string;
  prev_event_with_location?: {
    summary?: string;
    location: string;
    end?: string;
  };
  next_event_with_location?: {
    summary?: string;
    location: string;
    start?: string;
  };
  prev_leg?: {
    duration_text: string;
    distance_text: string;
    slack_seconds: number;
  };
  next_leg?: {
    duration_text: string;
    distance_text: string;
    slack_seconds: number;
  };
};

export type SendApprovalPromptArgs = {
  insured_name: string;
  carrier: string;
  client?: string;             // e.g. "Premier Claims" / "Straight Line Global"
  claim_number: string;        // primary claim #
  file_number?: string;        // FileTrac file # (if different from claim_number)
  claim_phone: string;         // POC primary phone
  loss_address?: string;
  sms_text: string;            // verbatim rendered SMS (from draft_inspection_sms)
  slot: ApprovalSlot;
  // Optional overrides — fall back to defaults / env.
  ntfy_topic?: string;
  ntfy_server?: string;
  // Where Hakiel should reply for approval — defaults to "Dispatch".
  reply_channel?: string;
};

export type SendApprovalPromptResult =
  | {
      ok: true;
      ntfy_url: string;
      title: string;
      body: string;
      priority: number;
    }
  | { ok: false; error: string };

function formatSlack(seconds: number | undefined): string {
  if (seconds === undefined) return "?";
  const min = Math.round(seconds / 60);
  if (min < 0) return `${min}m late`;
  return `${min}m slack`;
}

function buildBody(args: SendApprovalPromptArgs): string {
  const { slot } = args;
  const lines: string[] = [];

  lines.push(`Insured: ${args.insured_name}`);
  if (args.client && args.carrier) {
    lines.push(`Carrier: ${args.carrier} (${args.client})`);
  } else {
    lines.push(`Carrier: ${args.carrier}`);
  }
  const cn = args.file_number && args.file_number !== args.claim_number
    ? `${args.file_number} (FT) / ${args.claim_number} (carrier)`
    : args.claim_number;
  lines.push(`Claim #: ${cn}`);
  lines.push(`Phone: ${args.claim_phone}`);
  if (args.loss_address) lines.push(`Loss: ${args.loss_address}`);

  lines.push("");
  const slotLine = slot.weekday
    ? `Proposed slot: ${slot.weekday} ${slot.date}, ${slot.start_label}–${slot.end_label}`
    : `Proposed slot: ${slot.date}, ${slot.start_label}–${slot.end_label}`;
  lines.push(slotLine);
  lines.push(`Rationale: ${slot.rationale}`);

  // Last-location anchor — REQUIRED by playbook step 7.
  if (slot.prev_event_with_location) {
    const prev = slot.prev_event_with_location;
    const summary = prev.summary ? ` (${prev.summary})` : "";
    lines.push(`Last location before: ${prev.location}${summary}`);
  } else {
    lines.push(`Last location before: (none on calendar — coming from home)`);
  }

  if (slot.prev_leg) {
    lines.push(`Prev drive: ${slot.prev_leg.duration_text} (${slot.prev_leg.distance_text}), ${formatSlack(slot.prev_leg.slack_seconds)}`);
  }
  if (slot.next_event_with_location) {
    const next = slot.next_event_with_location;
    const summary = next.summary ? ` (${next.summary})` : "";
    lines.push(`Next location after: ${next.location}${summary}`);
  }
  if (slot.next_leg) {
    lines.push(`Next drive: ${slot.next_leg.duration_text} (${slot.next_leg.distance_text}), ${formatSlack(slot.next_leg.slack_seconds)}`);
  }
  if (slot.feasible === false) {
    lines.push(`⚠️ INFEASIBLE: ${slot.infeasible_reason ?? "(reason missing)"}`);
  }

  lines.push("");
  lines.push("--- DRAFTED SMS ---");
  lines.push(args.sms_text);
  lines.push("--- END SMS ---");
  lines.push("");
  lines.push(`Reply "send" through ${args.reply_channel ?? "Dispatch"} to fire. Anything else holds.`);

  return lines.join("\n");
}

/**
 * Step 7 of the post-claim playbook (D1) — push approval prompt to Hakiel
 * via ntfy. Subject prefixed `[APPROVE]` per the topic convention. Body
 * contains: insured + carrier + claim # + phone + loss, proposed slot
 * with rationale + drive-time slack, last-location anchor (REQUIRED per
 * playbook step 7 so Hakiel can sanity-check routing), drafted SMS verbatim,
 * and reply instructions.
 *
 * Hakiel replies through Cloud Dispatch in chat ("send" / "hold") — this
 * tool only fires the prompt, not the SMS itself. D2 handles the approval
 * → voice_send_sms wiring.
 */
export async function sendApprovalPrompt(args: SendApprovalPromptArgs): Promise<SendApprovalPromptResult> {
  const topic = args.ntfy_topic
    || process.env.CLAIM_MONITOR_NTFY_TOPIC
    || DEFAULT_NTFY_TOPIC;
  const server = args.ntfy_server
    || process.env.CLAIM_MONITOR_NTFY_SERVER
    || DEFAULT_NTFY_SERVER;

  const fullTitle = `[APPROVE] ${args.insured_name} — ${args.client ?? args.carrier}`;
  const safeTitle = asciiSafe(fullTitle) || "[APPROVE]";
  const body = buildBody(args);
  // Prefix the title (with any non-ASCII chars stripped) into the body so the
  // user still sees the full title text in iOS Dispatch even if the header
  // had to drop characters.
  const messageBody = `${fullTitle}\n\n${body}`;
  const priority = 4; // high — needs attention

  const url = `${server}/${encodeURIComponent(topic)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Title": safeTitle,
        "Priority": String(priority),
        "Tags": "warning,bell",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: messageBody,
    });
    if (!res.ok) {
      return { ok: false, error: `ntfy POST failed: HTTP ${res.status} ${res.statusText}` };
    }
  } catch (e: any) {
    return { ok: false, error: `ntfy POST error: ${e?.message ?? e}` };
  }

  return {
    ok: true,
    ntfy_url: url,
    title: fullTitle,
    body,
    priority,
  };
}

export async function sendApprovalPromptTool(args: SendApprovalPromptArgs): Promise<CallToolResult> {
  const result = await sendApprovalPrompt(args);
  return ok(JSON.stringify(result, null, 2));
}
