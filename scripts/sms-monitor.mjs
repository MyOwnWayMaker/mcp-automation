#!/usr/bin/env node
/**
 * sms-monitor.mjs — outbound check-back + inbound reply detection for
 * inspection first-contact SMS.
 *
 * On CONFIRM, auto-creates a Google Calendar event for the proposed slot
 * (calendar is Hakiel's own — internal write, allowed by TOP RULE).
 * NEVER auto-writes to any third-party portal (FileTrac, XA, etc.). Those
 * always require per-action confirmation; the script only DETECTS and
 * ntfy's a suggested action.
 *
 * Env:
 *   SMS_MONITOR_NTFY_TOPIC  default `hakiel-mac-mini-xa-reauth`
 *   SMS_MONITOR_DRY_RUN     `1` skips ntfy + calendar + tracker writes
 *   CALENDAR_TIMEZONE       default `America/Los_Angeles` (PT)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Load .env.local first (Mac mini Google paths), then .env as fallback.
for (const f of [".env.local", ".env"]) {
  const p = path.join(REPO, f);
  if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
}
const TRACKER_PATH = path.join(REPO, "data/sms_tracker.json");
const NTFY_TOPIC = process.env.SMS_MONITOR_NTFY_TOPIC || "hakiel-mac-mini-xa-reauth";
const DRY_RUN = process.env.SMS_MONITOR_DRY_RUN === "1";
const CAL_TZ = process.env.CALENDAR_TIMEZONE || "America/Los_Angeles";
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const CONFIRM_PATTERNS = [
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|kk|k|sounds good|that works|works for me|will do|ill be there|i'?ll be there|see you|see ya|see u|perfect|great|fine|cool|alright|aight|i can|i'?m available|im available|i'?m home|im home|got it|copy)\s*[.!]?\s*$/i,
  /\b(sounds good|that works|works for me|see you (then|tomorrow|tmrw)|i'?ll be (there|home|available)|that'?s (fine|good)|please come|that time works)\b/i,
];

const DECLINE_PATTERNS = [
  /\b(can'?t|cannot|won'?t work|doesn'?t work|busy|not (good|able|available)|reschedule|different time|another (day|time)|push (it )?back|move it|please (move|change)|let'?s do (another|a different))\b/i,
  /^\s*no\s*[.!]?\s*$/i,
];

const QUESTION_PATTERNS = [
  /\?/,
  /\b(what time|when is|where|how about|are you|how long|how much|will (you|it)|do (you|i)|should i)\b/i,
];

export function loadTracker(p = TRACKER_PATH) {
  if (!fs.existsSync(p)) return { pending: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveTracker(t, p = TRACKER_PATH) {
  if (DRY_RUN) {
    console.log("[dry-run] would save tracker:", JSON.stringify(t, null, 2));
    return;
  }
  fs.writeFileSync(p, JSON.stringify(t, null, 2));
}

async function loadVoice() {
  const p = path.join(REPO, "dist/tools/voice.js");
  if (!fs.existsSync(p)) throw new Error("dist/tools/voice.js missing — run `npm run build`");
  return import(p);
}

async function loadCalendar() {
  const p = path.join(REPO, "dist/tools/calendar.js");
  if (!fs.existsSync(p)) throw new Error("dist/tools/calendar.js missing — run `npm run build`");
  return import(p);
}

/**
 * Parse a proposed time window like "10am-11am", "10:00am - 11:30am",
 * "14:00-15:00" into { startHour, startMin, endHour, endMin }. Returns null
 * if unparseable; falls back upstream to a 1-hour default.
 */
export function parseWindow(win) {
  if (!win) return null;
  const s = String(win).trim().toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?-(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let [, h1, m1, p1, h2, m2, p2] = m;
  const to24 = (h, p) => {
    let hh = Number(h);
    if (p === "pm" && hh < 12) hh += 12;
    if (p === "am" && hh === 12) hh = 0;
    return hh;
  };
  // If only end has am/pm, infer start uses same.
  if (!p1 && p2) p1 = p2;
  if (!p2 && p1) p2 = p1;
  return {
    startHour: to24(h1, p1 || "am"),
    startMin: m1 ? Number(m1) : 0,
    endHour: to24(h2, p2 || "am"),
    endMin: m2 ? Number(m2) : 0,
  };
}

/**
 * Build start/end ISO strings (with explicit tz offset) for a date + window
 * in the configured calendar timezone. Uses Intl to get the right offset for
 * that specific date (handles DST).
 */
export function buildEventTimes(dateIso, win, tz) {
  const parsed = parseWindow(win);
  // Default to 9am-10am if no window provided.
  const sH = parsed?.startHour ?? 9;
  const sM = parsed?.startMin ?? 0;
  const eH = parsed?.endHour ?? sH + 1;
  const eM = parsed?.endMin ?? sM;
  const offset = tzOffset(dateIso, tz); // e.g. "-07:00"
  const pad = (n) => String(n).padStart(2, "0");
  const start = `${dateIso}T${pad(sH)}:${pad(sM)}:00${offset}`;
  const end = `${dateIso}T${pad(eH)}:${pad(eM)}:00${offset}`;
  return { start, end };
}

export function tzOffset(dateIso, tz) {
  // Build a Date at noon UTC for the given calendar date, then ask Intl
  // for the "shortOffset" name in that tz. Format: GMT-7, GMT-07:00, etc.
  const ref = new Date(`${dateIso}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
  const parts = fmt.formatToParts(ref);
  const tzn = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
  const m = tzn.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  const sign = m[1];
  const hh = String(Number(m[2])).padStart(2, "0");
  const mm = m[3] ? m[3].padStart(2, "0") : "00";
  return `${sign}${hh}:${mm}`;
}

/** Build the calendar event title from a tracker entry. */
export function buildEventTitle(entry) {
  const tail = entry.claim_id ? ` (${entry.ia_firm || "?"} ${entry.claim_id})` : "";
  return `Inspection — ${entry.contact_name}${tail}`;
}

/**
 * Build a rich calendar event description. Reads from entry.claim_context
 * (populated at register time by sms-register-pending --claim-context-json,
 * or backfilled manually). Falls back gracefully when fields are missing.
 *
 * Sections (each blank-line separated):
 *   - Header        : insured + loss_type, claim/file numbers, loss date
 *   - LOSS          : loss description + coverage/deductible
 *   - LOCATION      : loss address
 *   - INSURED CONTACT
 *   - DESK ADJUSTER (Carrier)  ← the "DA" in Hakiel's vocabulary
 *   - IA FIRM       ← the firm that routed the assignment (PCAS, USCS, etc.)
 *   - DA INSTRUCTIONS / NOTES  ← bulleted special-handling notes
 *   - SMS           : audit trail (send/confirm timestamps, window)
 */
export function buildEventDescription(entry) {
  const c = entry.claim_context || {};
  const sections = [];

  const headerLines = [
    `${entry.contact_name} — ${c.loss_type || "Inspection"}`,
    [
      c.claim_number ? `Claim: ${c.claim_number}` : null,
      c.file_number ? `File #: ${c.file_number}` : null,
      entry.claim_id ? `FT: ${entry.claim_id}` : null,
    ].filter(Boolean).join(" | ") || null,
    c.date_of_loss ? `Loss Date: ${c.date_of_loss}` : null,
  ].filter(Boolean);
  sections.push(headerLines.join("\n"));

  if (c.loss_description || c.coverage_limit || c.deductible) {
    const lines = ["LOSS"];
    if (c.loss_description) lines.push(c.loss_description);
    const cov = [];
    if (c.coverage_limit) cov.push(`Coverage: ${c.coverage_limit}`);
    if (c.deductible) cov.push(`Deductible: ${c.deductible}`);
    if (cov.length) lines.push(cov.join(" | "));
    sections.push(lines.join("\n"));
  }

  if (c.loss_address) sections.push(`LOCATION\n${c.loss_address}`);

  const contactBits = [
    entry.contact_name,
    entry.contact_phone,
    c.insured_email,
  ].filter(Boolean).join(" — ");
  sections.push(`INSURED CONTACT\n${contactBits}`);

  if (c.da_name || c.da_company || c.da_email || c.da_phone) {
    const lines = ["DESK ADJUSTER (Carrier)"];
    const nameLine = [c.da_name, c.da_title].filter(Boolean).join(" — ");
    if (nameLine) lines.push(nameLine);
    if (c.da_company) lines.push(c.da_company);
    const emails = [c.da_email, c.da_alt_email].filter(Boolean).join(" | ");
    if (emails) lines.push(emails);
    if (c.da_phone) lines.push(`Direct: ${c.da_phone}`);
    sections.push(lines.join("\n"));
  }

  if (entry.ia_firm || c.ia_firm_name) {
    const lines = ["IA FIRM"];
    const label = c.ia_firm_name || entry.ia_firm;
    lines.push(label + (c.ia_firm_license ? ` (Lic ${c.ia_firm_license})` : ""));
    const contact = [c.ia_firm_email, c.ia_firm_phone].filter(Boolean).join(" | ");
    if (contact) lines.push(contact);
    if (c.ia_firm_contact) lines.push(`Routed by: ${c.ia_firm_contact}`);
    sections.push(lines.join("\n"));
  }

  if (Array.isArray(c.da_instructions) && c.da_instructions.length) {
    sections.push(["DA INSTRUCTIONS / NOTES", ...c.da_instructions.map((s) => `• ${s}`)].join("\n"));
  }

  if (c.drive_folder_url || c.drive_folder_id) {
    const url = c.drive_folder_url
      || `https://drive.google.com/drive/folders/${c.drive_folder_id}`;
    sections.push(`FILES\n${url}`);
  }

  const smsBits = [
    "SMS",
    `Sent: ${entry.send_iso}`,
    `Confirmed: ${entry.last_processed_inbound_iso || "?"}`,
    entry.proposed_time_window ? `Window: ${entry.proposed_time_window}` : null,
  ].filter(Boolean);
  sections.push(smsBits.join("\n"));

  sections.push("(Auto-created from SMS confirmation by sms-monitor.)");

  return sections.join("\n\n");
}

/**
 * Pre-create dedup: walk the calendar around the proposed start, return any
 * event whose title matches our exact title and whose start matches our start.
 * Returns { event_id } on hit, null on miss. Listing errors → null (don't block
 * create on a transient outage; tracker's calendar_event_id is the primary guard).
 *
 * deps.calendarListEvents lets tests stub the API call.
 */
export async function findExistingCalendarEvent(entry, deps = {}) {
  if (!entry.proposed_date_iso) return null;
  const { start, end } = buildEventTimes(entry.proposed_date_iso, entry.proposed_time_window, CAL_TZ);
  const title = buildEventTitle(entry);
  const ONE_HOUR = 60 * 60 * 1000;
  const widerMin = new Date(new Date(start).getTime() - ONE_HOUR).toISOString();
  const widerMax = new Date(new Date(end).getTime() + ONE_HOUR).toISOString();
  let listFn = deps.calendarListEvents;
  if (!listFn) {
    const { calendarListEvents } = await loadCalendar();
    listFn = calendarListEvents;
  }
  try {
    const res = await listFn({
      time_min: widerMin,
      time_max: widerMax,
      query: entry.contact_name,
      max_results: 20,
    });
    const text = (res?.content || []).map((c) => c.text || "").join("\n");
    // Tool output shape (per dist/tools/calendar.ts):
    //   "ID: <id>\n<title>\nStart: <iso>\nEnd: <iso>\n\n---\n\n…"
    const blocks = text.split(/\n-{2,}\n?/).map((b) => b.trim()).filter(Boolean);
    for (const b of blocks) {
      const idM = b.match(/ID:\s*(\S+)/);
      const startM = b.match(/Start:\s*(\S+)/);
      if (!idM || !startM) continue;
      const lines = b.split("\n");
      const titleLine = (lines.find((l) => l.startsWith("Inspection")) || "").trim();
      if (startM[1] === start && titleLine === title) {
        return { event_id: idM[1] };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function createInspectionCalendarEvent(entry, deps = {}) {
  if (!entry.proposed_date_iso) return { ok: false, reason: "no proposed_date_iso" };
  if (entry.calendar_event_id) return { ok: false, reason: "already created", event_id: entry.calendar_event_id };

  // Defensive pre-create dedup: a prior event with the exact same title +
  // start (e.g. a tracker reset) → adopt it instead of duplicating.
  const existing = await findExistingCalendarEvent(entry, deps);
  if (existing?.event_id) {
    return { ok: false, reason: "already exists upstream", event_id: existing.event_id };
  }

  const createFn = deps.calendarCreateEvent ?? (await loadCalendar()).calendarCreateEvent;
  const { start, end } = buildEventTimes(entry.proposed_date_iso, entry.proposed_time_window, CAL_TZ);
  const title = buildEventTitle(entry);
  const description = buildEventDescription(entry);
  if (DRY_RUN) {
    console.log(`[dry-run cal] would create: ${title} ${start} → ${end}`);
    return { ok: true, dry: true, start, end };
  }
  const res = await createFn({ title, start, end, description });
  const text = (res?.content || []).map((c) => c.text || "").join("\n");
  let event_id = null;
  const idMatch = text.match(/^ID:\s*(\S+)/m) || text.match(/"id"\s*:\s*"([^"]+)"/);
  if (idMatch) event_id = idMatch[1];
  return { ok: true, event_id, raw: text.slice(0, 400), start, end };
}

async function fetchThread(thread_id) {
  const { voiceGetThread } = await loadVoice();
  const res = await voiceGetThread({ thread_id, order: "oldest_first", max_messages: 200 });
  const text = (res?.content || []).map((c) => c.text || "").join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { messages: [] };
  }
}

export function classify(body) {
  const b = (body || "").trim();
  if (!b) return "UNCLEAR";
  // Question takes priority — "Okay what time?" is still a question.
  for (const re of QUESTION_PATTERNS) if (re.test(b)) {
    // But "Are you available?" / "Will you be there?" should NOT auto-confirm.
    // If it ALSO matches confirm AND has no '?', treat as confirm.
    if (!/\?/.test(b)) {
      for (const cre of CONFIRM_PATTERNS) if (cre.test(b)) return "CONFIRM";
    }
    return "UNCLEAR";
  }
  for (const re of CONFIRM_PATTERNS) if (re.test(b)) return "CONFIRM";
  for (const re of DECLINE_PATTERNS) if (re.test(b)) return "DECLINE";
  return "UNCLEAR";
}

/** Strip non-Latin-1 chars (em-dashes, fancy quotes, emoji) from HTTP header values. */
export function asciiHeader(s) {
  return String(s)
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, "?");
}

async function ntfy({ title, body, priority = "default", tags = "" }) {
  if (DRY_RUN) {
    console.log(`[dry-run ntfy] [${priority}] ${title}\n${body}`);
    return;
  }
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers: {
        Title: asciiHeader(title),
        Priority: priority,
        Tags: asciiHeader(tags),
      },
      body,
    });
  } catch (e) {
    console.error("ntfy error:", e.message);
  }
}

function fmtPST(iso) {
  if (!iso) return "?";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
}

/**
 * Process a single tracker entry. Side-effects (fetchThread, ntfy, calendar)
 * are injected via `deps` so tests can stub them. Production wires the real
 * implementations in the entry point at the bottom of this file.
 */
export async function processEntry(entry, now, deps = {}) {
  const fetchThreadFn = deps.fetchThread ?? fetchThread;
  const ntfyFn = deps.ntfy ?? ntfy;
  const createCalFn = deps.createInspectionCalendarEvent ?? createInspectionCalendarEvent;
  if (entry.resolved) return { entry, action: "skip:resolved" };
  let thread;
  try {
    thread = await fetchThreadFn(entry.thread_id);
  } catch (e) {
    console.error(`thread fetch failed for ${entry.thread_id}: ${e.message}`);
    return { entry, action: "skip:fetch-failed" };
  }
  const sendTs = new Date(entry.send_iso).getTime();
  const sinceCutoff = entry.last_processed_inbound_iso
    ? new Date(entry.last_processed_inbound_iso).getTime()
    : sendTs;
  const newInbound = (thread.messages || []).filter(
    (m) => m.direction === "inbound" && m.timestamp_iso && new Date(m.timestamp_iso).getTime() > sinceCutoff
  );

  if (newInbound.length > 0) {
    const last = newInbound[newInbound.length - 1];
    const intent = classify(last.body);
    const dateLabel = entry.proposed_date_iso || "(no date)";
    const window = entry.proposed_time_window ? ` ${entry.proposed_time_window}` : "";

    // On CONFIRM: auto-create calendar event (internal write — allowed).
    let calLine = "";
    if (intent === "CONFIRM") {
      try {
        const cal = await createCalFn(entry);
        if (cal.ok && cal.event_id) {
          entry.calendar_event_id = cal.event_id;
          calLine = `\nCalendar: created event ${cal.event_id} (${cal.start} → ${cal.end})`;
        } else if (cal.ok && cal.dry) {
          calLine = `\nCalendar [dry-run]: would create (${cal.start} → ${cal.end})`;
        } else if (cal.ok) {
          calLine = `\nCalendar: created (id not parsed — see logs)`;
        } else if (cal.event_id) {
          // Dedup hit: an event already exists (either we created it on a
          // prior tick, or a sibling did). Adopt the id so the tracker reflects
          // reality and we don't try again next tick.
          entry.calendar_event_id = cal.event_id;
          calLine = `\nCalendar: adopted existing ${cal.event_id} — ${cal.reason}`;
        } else {
          calLine = `\nCalendar: skipped — ${cal.reason}`;
        }
      } catch (e) {
        calLine = `\nCalendar: ERROR — ${e.message}`;
      }
    }

    const ntfyTitle = `SMS reply from ${entry.contact_name} — ${intent}`;
    const ntfyBody = [
      `Claim: ${entry.claim_id || "?"} (${entry.ia_firm || "?"})`,
      `Contact: ${entry.contact_name} (${entry.contact_phone})`,
      `Reply (${fmtPST(last.timestamp_iso)}): ${last.body}`,
      ``,
      intent === "CONFIRM"
        ? `Suggested: set FT planned inspection ${dateLabel}${window}. Reply "yes set ${dateLabel}" to authorize.${calLine}`
        : intent === "DECLINE"
          ? `Suggested: propose a new slot. Their reply suggests they cannot make ${dateLabel}${window}.`
          : `Unclear — read the full thread, then decide.`,
    ].join("\n");
    await ntfyFn({
      title: ntfyTitle,
      body: ntfyBody,
      priority: intent === "CONFIRM" ? "high" : "default",
      tags: intent === "CONFIRM" ? "white_check_mark" : intent === "DECLINE" ? "warning" : "speech_balloon",
    });
    entry.last_processed_inbound_iso = last.timestamp_iso;
    if (intent === "CONFIRM") entry.resolved = true;
    return { entry, action: `inbound:${intent}` };
  }

  if (!entry.two_hour_warned && now - sendTs >= TWO_HOURS_MS) {
    await ntfyFn({
      title: `No SMS reply yet — ${entry.contact_name}`,
      body: [
        `Claim: ${entry.claim_id || "?"} (${entry.ia_firm || "?"})`,
        `Contact: ${entry.contact_name} (${entry.contact_phone})`,
        `Sent: ${fmtPST(entry.send_iso)} (${Math.round((now - sendTs) / (60 * 60 * 1000))}h ago)`,
        `Proposed: ${entry.proposed_date_iso || "?"}${entry.proposed_time_window ? " " + entry.proposed_time_window : ""}`,
        ``,
        `Consider following up via call/email.`,
      ].join("\n"),
      priority: "default",
      tags: "hourglass_flowing_sand",
    });
    entry.two_hour_warned = true;
    return { entry, action: "two_hour_warned" };
  }
  return { entry, action: "skip:no-change" };
}

export async function runMonitorOnce({ trackerPath = TRACKER_PATH, deps = {}, now = Date.now() } = {}) {
  const tracker = loadTracker(trackerPath);
  const pending = Array.isArray(tracker.pending) ? tracker.pending : [];
  if (pending.length === 0) return { mutated: false, actions: [] };
  let mutated = false;
  const actions = [];
  for (let i = 0; i < pending.length; i++) {
    const before = JSON.stringify(pending[i]);
    const { entry, action } = await processEntry(pending[i], now, deps);
    pending[i] = entry;
    if (JSON.stringify(entry) !== before) mutated = true;
    actions.push({ id: entry.id || entry.thread_id, action });
  }
  tracker.pending = pending;
  if (mutated) saveTracker(tracker, trackerPath);
  return { mutated, actions, tracker };
}

// Entry point — only run when invoked directly (not when imported by tests).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  (async () => {
    console.log(`=== sms-monitor ${new Date().toISOString()} ===`);
    const { mutated, actions } = await runMonitorOnce();
    for (const a of actions) console.log(`[${a.id}] ${a.action}`);
    if (actions.length === 0) console.log("no pending entries — exit");
    console.log(`done. mutated=${mutated}`);
  })().catch((e) => {
    console.error("sms-monitor fatal:", e);
    process.exit(1);
  });
}
