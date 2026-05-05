import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { voiceSendSms } from "./voice.js";
import { calendarCreateEvent } from "./calendar.js";
import { notionCreateDatabaseItem } from "./notion.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// MCP tools wrap their JSON output inside { content: [{ type: "text", text: "..." }] }.
// For internal composition we unwrap and parse — same convention as claim_fetcher.ts.
function unwrap(r: CallToolResult): any {
  const c0 = r.content?.[0];
  const text = c0 && c0.type === "text" ? c0.text : "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `non-JSON tool output: ${text.slice(0, 200)}` };
  }
}

// ─── Helpers for the calendar-event payload ───────────────────────────────────

function buildEventTitle(args: HandleApprovalArgs): string {
  if (args.event_title) return args.event_title;
  const who = args.insured_name;
  const short = args.client ?? args.carrier;
  return `[ADJ] ${who} Inspection — ${short}`;
}

function buildEventDescription(args: HandleApprovalArgs): string {
  const lines: string[] = [];
  lines.push(`Phone: ${args.insured_phone}`);
  if (args.alternate_phone) lines.push(`Alt phone: ${args.alternate_phone}`);
  if (args.file_number && args.file_number !== args.claim_number) {
    lines.push(`File #: ${args.file_number}`);
    lines.push(`Claim #: ${args.claim_number}`);
  } else {
    lines.push(`Claim #: ${args.claim_number}`);
  }
  if (args.policy_number) lines.push(`Policy #: ${args.policy_number}`);
  lines.push(`Carrier: ${args.carrier}`);
  if (args.client) lines.push(`Client: ${args.client}`);
  if (args.examiner_name || args.examiner_email || args.examiner_phone) {
    const bits = [args.examiner_name, args.examiner_email, args.examiner_phone].filter(Boolean);
    lines.push(`Examiner: ${bits.join(" — ")}`);
  }
  if (args.date_of_loss) lines.push(`Date of Loss: ${args.date_of_loss}`);
  if (args.loss_type) lines.push(`Loss type: ${args.loss_type}`);
  if (args.special_instructions) {
    lines.push("");
    lines.push(`Special instructions:`);
    lines.push(args.special_instructions);
  }
  return lines.join("\n");
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type HandleApprovalArgs = {
  // SMS payload
  insured_phone: string;
  sms_text: string;
  // Calendar event metadata
  insured_name: string;            // shown in event title
  carrier: string;
  client?: string;                 // short client code; falls back to carrier
  claim_number: string;
  file_number?: string;
  policy_number?: string;
  date_of_loss?: string;
  loss_type?: string;
  examiner_name?: string;
  examiner_email?: string;
  examiner_phone?: string;
  alternate_phone?: string;
  loss_address: string;
  slot_start: string;              // ISO with offset
  slot_end: string;
  special_instructions?: string;
  event_title?: string;            // optional override; default "[ADJ] {Insured} Inspection — {Client or Carrier}"
  calendar_id?: string;            // default "primary"
  // Notion logging (optional)
  notion_database_id?: string;
  // Test/dev escapes
  skip_sms?: boolean;
  skip_calendar?: boolean;
  skip_notion?: boolean;
  // SMS send args
  voice_thread_id?: string;        // pass to reuse an existing GV thread
  voice_skip_verify?: boolean;
};

export type HandleApprovalResult = {
  ok: boolean;
  sms?: { ok: boolean; sent?: boolean; verified?: boolean; error?: string; skipped?: boolean };
  calendar?: { ok: boolean; event_id?: string; link?: string; error?: string; skipped?: boolean };
  notion?: { ok: boolean; page_id?: string; link?: string; error?: string; skipped?: boolean };
  // Top-level error if a precondition failed (e.g. SMS aborted everything).
  error?: string;
};

/**
 * Step 8-10 of the post-claim playbook (D2). Called by Cloud Dispatch after
 * Hakiel replies "send" to the D1 approval prompt.
 *
 * Sequential pipeline:
 *   1. voice_send_sms — fires the verbatim approved SMS to the POC.
 *   2. calendar_create_event — adds [ADJ] event to primary calendar with
 *      color 6 (Tangerine) per the locked color convention.
 *   3. notion_create_database_item (if database_id provided) — logs the
 *      open-assignment row.
 *
 * Failure semantics:
 *   - SMS failure aborts the whole pipeline (no calendar/Notion). The
 *     inspection isn't actually scheduled with the insured, so a calendar
 *     event would be premature.
 *   - Calendar failure does NOT block Notion (logging is independent).
 *   - Each step's result is returned individually so the caller can retry
 *     selectively.
 */
export async function handleClaimApproval(args: HandleApprovalArgs): Promise<HandleApprovalResult> {
  const result: HandleApprovalResult = { ok: true };

  // ── 1. SMS ──────────────────────────────────────────────────────────────
  if (args.skip_sms) {
    result.sms = { ok: true, skipped: true };
  } else {
    const smsResult = unwrap(
      await voiceSendSms({
        number: args.insured_phone,
        body: args.sms_text,
        thread_id: args.voice_thread_id,
        skip_verify: args.voice_skip_verify,
      }),
    );
    if (smsResult.ok) {
      result.sms = {
        ok: true,
        sent: smsResult.sent ?? true,
        verified: smsResult.verified,
      };
    } else {
      result.sms = { ok: false, error: smsResult.error ?? "voice_send_sms returned ok=false" };
      result.ok = false;
      result.error = `SMS send failed: ${result.sms.error}`;
      // Abort — no calendar / Notion for an SMS that didn't go.
      return result;
    }
  }

  // ── 2. Calendar event ──────────────────────────────────────────────────
  if (args.skip_calendar) {
    result.calendar = { ok: true, skipped: true };
  } else {
    // calendarCreateEvent returns plain text (not JSON), so we grab the raw
    // string and regex out the ID + Link lines. "Event created: ...\nID: X\nLink: Y".
    const calRaw = await calendarCreateEvent({
      title: buildEventTitle(args),
      start: args.slot_start,
      end: args.slot_end,
      location: args.loss_address,
      description: buildEventDescription(args),
      color_id: 6, // Tangerine — [ADJ] convention (locked 2026-05-04)
      calendar_id: args.calendar_id,
    });
    const c0 = calRaw.content?.[0];
    const calText = c0 && c0.type === "text" ? c0.text : "";
    const idMatch = calText.match(/ID:\s*(\S+)/);
    const linkMatch = calText.match(/Link:\s*(\S+)/);
    if (idMatch) {
      result.calendar = {
        ok: true,
        event_id: idMatch[1],
        link: linkMatch?.[1],
      };
    } else {
      result.calendar = {
        ok: false,
        error: calText || "calendar create returned no event ID",
      };
      result.ok = false;
    }
  }

  // ── 3. Notion logging (optional) ────────────────────────────────────────
  if (args.skip_notion || !args.notion_database_id) {
    result.notion = { ok: true, skipped: true };
  } else {
    const title = `${args.insured_name} — ${args.client ?? args.carrier} (${args.claim_number})`;
    const properties: Record<string, string> = {
      Carrier: args.carrier,
      "Claim #": args.claim_number,
      Phone: args.insured_phone,
      "Loss Address": args.loss_address,
      "Inspection Slot": `${args.slot_start} → ${args.slot_end}`,
    };
    if (args.client) properties.Client = args.client;
    if (args.file_number) properties["File #"] = args.file_number;
    if (args.policy_number) properties["Policy #"] = args.policy_number;
    if (args.examiner_name) properties.Examiner = args.examiner_name;
    if (args.loss_type) properties["Loss Type"] = args.loss_type;
    if (args.date_of_loss) properties["Date of Loss"] = args.date_of_loss;

    const notionResult = unwrap(
      await notionCreateDatabaseItem({
        database_id: args.notion_database_id,
        title,
        properties,
      }),
    );
    if (notionResult.ok || notionResult.id || notionResult.url) {
      result.notion = {
        ok: true,
        page_id: notionResult.id,
        link: notionResult.url,
      };
    } else {
      result.notion = {
        ok: false,
        error: notionResult.error ?? "notion_create_database_item returned ok=false",
      };
      // Notion failure doesn't flip top-level ok — logging is non-critical.
    }
  }

  return result;
}

export async function handleClaimApprovalTool(args: HandleApprovalArgs): Promise<CallToolResult> {
  const result = await handleClaimApproval(args);
  return ok(JSON.stringify(result, null, 2));
}
