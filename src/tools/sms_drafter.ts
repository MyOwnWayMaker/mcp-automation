import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const LA_TZ = "America/Los_Angeles";

// ─── Formatters ────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const last2 = n % 100;
  if (last2 >= 11 && last2 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Format an instant in LA local time as "Tuesday May 5th".
 * Day-of-week + full month name + day-with-ordinal. No year, no numeric date.
 */
function formatProposedDate(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const day = parseInt(parts.day);
  return `${parts.weekday} ${parts.month} ${ordinal(day)}`;
}

/**
 * Format a single LA-local instant as "7am" or "7:30am".
 * No leading zero, lowercase am/pm, no colon when minutes are zero.
 */
function formatTimePart(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const h = parts.hour;
  const m = parts.minute;
  const dp = (parts.dayPeriod ?? "").replace(/\s/g, "").toLowerCase();
  if (m === "00") return `${h}${dp}`;
  return `${h}:${m}${dp}`;
}

/**
 * "7am-8am" — no colons (when on the hour), no spaces around the dash,
 * lowercase am/pm. Falls back to "9:30am-10:30am" form when the slot
 * doesn't land on the hour (e.g. an adjacency slot at 10:30).
 */
function formatProposedTimeFrame(start: Date, end: Date): string {
  return `${formatTimePart(start)}-${formatTimePart(end)}`;
}

/**
 * "Kathleen" / "Kathleen and Margarita" / "Kathleen, Margarita, and Carlos".
 * Single name → as-is. Two names → "A and B". Three+ → Oxford comma.
 */
function formatFirstNameOrNames(names: string[]): string {
  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  const head = cleaned.slice(0, -1).join(", ");
  return `${head}, and ${cleaned[cleaned.length - 1]}`;
}

/**
 * Pull a list of first names from a single insured_name string. Handles:
 *   "OSCAR RUIZ RAMIREZ"          → ["OSCAR"]
 *   "Kathleen Lowe"                → ["Kathleen"]
 *   "Kathleen Lowe / Margarita Patino" → ["Kathleen", "Margarita"]
 *   "Kathleen Lowe & Margarita Patino" → ["Kathleen", "Margarita"]
 *   "Kathleen Lowe and Margarita Patino" → ["Kathleen", "Margarita"]
 * Pass insured_first_names directly when this guess is wrong.
 */
function splitInsuredNames(combined: string): string[] {
  const sep = /\s*(?:\/|&|\band\b)\s*/i;
  const people = combined.split(sep).map((s) => s.trim()).filter(Boolean);
  return people.map((p) => {
    const first = p.split(/\s+/)[0];
    // Title-case if all upper.
    if (first === first.toUpperCase()) {
      return first.charAt(0) + first.slice(1).toLowerCase();
    }
    return first;
  });
}

// ─── Public API ────────────────────────────────────────────────────────────────

export type DraftSmsArgs = {
  // Either provide first names directly...
  insured_first_names?: string[];
  // ...or pass the combined insured_name field and we'll split it.
  insured_name?: string;
  // Slot start + end as ISO strings (with offset). Typically the picker output.
  slot_start: string;
  slot_end: string;
};

export type DraftSmsResult =
  | {
      ok: true;
      sms_text: string;
      first_name_or_names: string;
      proposed_date: string;
      proposed_time_frame: string;
    }
  | { ok: false; error: string };

/**
 * Draft Hakiel's standard first-contact SMS. Verbatim template — substitution
 * rules per the locked 2026-05-04 spec:
 *   {first_name_or_names} — single name as-is, two names "A and B",
 *      three+ Oxford-comma "A, B, and C".
 *   {proposed_date} — "Tuesday May 5th" (day-of-week + full month +
 *      ordinal day). Never numeric, never year.
 *   {proposed_time_frame} — "7am-8am" (no colons on the hour, no spaces
 *      around dash, lowercase am/pm).
 * Three paragraphs, blank lines between, no signature.
 */
export function draftInspectionSms(args: DraftSmsArgs): DraftSmsResult {
  const start = new Date(args.slot_start);
  const end = new Date(args.slot_end);
  if (isNaN(start.getTime())) return { ok: false, error: `bad slot_start: ${args.slot_start}` };
  if (isNaN(end.getTime())) return { ok: false, error: `bad slot_end: ${args.slot_end}` };

  let names = args.insured_first_names ?? [];
  if (names.length === 0 && args.insured_name) {
    names = splitInsuredNames(args.insured_name);
  }
  if (names.length === 0) return { ok: false, error: "no insured first name(s) provided" };

  const first_name_or_names = formatFirstNameOrNames(names);
  const proposed_date = formatProposedDate(start);
  const proposed_time_frame = formatProposedTimeFrame(start, end);

  const sms_text =
`Hello ${first_name_or_names}. This is a courtesy text from your field adjuster, Hakiel McQueen.

I'm texting to conveniently schedule an inspection for the recent damages to your property.

The next opening I have is ${proposed_date} between ${proposed_time_frame}. Can you be available at this time?`;

  return {
    ok: true,
    sms_text,
    first_name_or_names,
    proposed_date,
    proposed_time_frame,
  };
}

export async function draftInspectionSmsTool(args: DraftSmsArgs): Promise<CallToolResult> {
  const result = draftInspectionSms(args);
  return ok(JSON.stringify(result, null, 2));
}
