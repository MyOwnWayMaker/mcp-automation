#!/usr/bin/env node
/**
 * sms-monitor.mjs — outbound check-back + inbound reply detection for
 * inspection first-contact SMS.
 *
 * On CONFIRM (new assignments):
 *   - auto-creates the Google Calendar event (internal write),
 *   - writes the Planned Inspection Date to FileTrac via the INTERNAL claimID
 *     — exactly once (inspection_date_written guard + only-if-empty read),
 *   - updates the Queststar mirror row (internal write),
 *   all pre-authorized by Hakiel's per-action approval of the outbound SMS
 *   (the approval prompt disclosed these write-backs; decided 2026-07-01).
 *   Re-inspection entries (claim_context.kind === "reinspection") NEVER touch
 *   CMS date fields — their agreement note goes through the outbox gate.
 *
 * On a counter-offer / unclear reply: drafts a response (accepts their time
 * when the calendar is free, else proposes the next opening) and pushes it to
 * the sms_outbox approval gate — it is NOT sent from here. DECLINE = ntfy only.
 *
 * CMS notes are never auto-posted from anywhere (standing rule, no exceptions).
 *
 * Env:
 *   SMS_MONITOR_NTFY_TOPIC  default `hakiel-mac-mini-xa-reauth`
 *   SMS_MONITOR_DRY_RUN     `1` skips ntfy + calendar + tracker/CMS writes
 *   CALENDAR_TIMEZONE       default `America/Los_Angeles` (PT)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  loadOutbox, saveOutbox, addProposal, findOpenProposal,
  ntfyPublish, APPROVALS_TOPIC,
} from "./pipeline/outbox.mjs";

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

async function loadFiletrac() {
  const p = path.join(REPO, "dist/tools/filetrac.js");
  if (!fs.existsSync(p)) throw new Error("dist/tools/filetrac.js missing — run `npm run build`");
  return import(p);
}

async function loadQueststar() {
  return import(path.join(REPO, "scripts/pipeline/queststar.mjs"));
}

async function loadSlotPicker() {
  return import(path.join(REPO, "dist/tools/slot_picker.js"));
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

export async function createInspectionCalendarEvent(entry, deps = {}) {
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

// ─── C3: Planned Inspection Date write-back (once, only-if-empty) ────────────

/** Read FileTrac's current "Date of Inspection" from a claim-detail dump. */
export function parseInspectionDate(detailText) {
  const m = String(detailText ?? "").match(/Date of Inspection:[ \t]*(.*)/);
  if (!m) return null;
  const v = m[1].trim();
  return v === "" || /\(not set\)/i.test(v) ? "" : v;
}

/**
 * Write the Planned Inspection Date to the CMS on CONFIRM. Guards:
 *   - re-inspections never touch date fields,
 *   - entry.inspection_date_written (once-only, survives tracker re-runs),
 *   - read-before-write: an existing FT value is adopted, never overwritten,
 *   - PCAS/USCS = FileTrac via INTERNAL claimID; SLG/XA is not wired → flag.
 * Returns a one-line outcome string for the ntfy body.
 */
export async function writeInspectionDate(entry, deps = {}) {
  const ctx = entry.claim_context || {};
  if (ctx.kind === "reinspection") return "FT date: not applicable (re-inspection — dates untouched)";
  if (entry.inspection_date_written) return "FT date: already written on a prior tick (guard)";
  if (!entry.proposed_date_iso) return "FT date: SKIPPED — no proposed date on entry";
  if (ctx.ia_firm === "SLG" || entry.ia_firm === "SLG") return "FT date: SKIPPED — SLG/XA write-back not wired (set in XA manually)";
  const claimId = ctx.ft_internal_claim_id;
  const companyIndex = ctx.company_index ?? entry.company_index;
  if (!claimId || companyIndex == null) return "FT date: SKIPPED — no internal claimID on entry (set manually)";

  const ft = deps.filetrac ?? await loadFiletrac();
  const detailText = (await ft.filetracGetClaim({ claim_id: String(claimId), company_index: companyIndex }))
    ?.content?.map((c) => c.text || "").join("\n") ?? "";
  const current = parseInspectionDate(detailText);
  if (current === null) return "FT date: SKIPPED — could not read claim (FT session?)";
  if (current !== "") {
    entry.inspection_date_written = true; // adopt — never overwrite
    return `FT date: already ${current} (adopted, left as-is)`;
  }
  if (DRY_RUN) return `FT date [dry-run]: would set ${entry.proposed_date_iso} on claim ${claimId}`;
  await ft.filetracUpdateClaimDates({
    claim_id: String(claimId), company_index: companyIndex,
    inspection_date: entry.proposed_date_iso,
  });
  entry.inspection_date_written = true;
  return `FT date: SET Date of Inspection ${entry.proposed_date_iso} (FT claim ${claimId})`;
}

/** Queststar mirror update on CONFIRM (internal write — no gate). */
export async function updateQueststarOnConfirm(entry, deps = {}) {
  const ctx = entry.claim_context || {};
  const rowId = ctx.queststar_row_id;
  if (!rowId) return "Queststar: no row id on entry — skipped";
  if (DRY_RUN) return `Queststar [dry-run]: would mark row ${rowId} scheduled`;
  const qs = deps.queststar ?? await loadQueststar();
  const when = `${entry.proposed_date_iso}${entry.proposed_time_window ? " " + entry.proposed_time_window : ""}`;
  await qs.updateClaimRow(rowId, { inspection_status: "Scheduled" });
  const rows = await qs.listClaimRows({ limit: 2000 });
  const row = rows.find((r) => Number(r.id) === Number(rowId));
  if (row) await qs.appendClaimNote(row, `Inspection confirmed by insured for ${when} (via SMS).`);
  return `Queststar: row ${rowId} inspection_status=Scheduled + note`;
}

// ─── C4: counter-offer extraction + gated reply drafts ──────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Pull an explicit time window (or single start time) from an inbound reply.
 *   "10-10:30" / "10:30am-11am" / "between 2 and 3pm" → {startHour,...,endHour,...}
 *   "2pm" / "at 10:30"                                 → 1-hour window from that time
 * Returns null when no concrete time is present.
 */
export function extractTimeFromReply(body) {
  const s = String(body ?? "").toLowerCase();
  let m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (m && !(m[2] == null && m[5] == null && m[3] == null && m[6] == null && Number(m[1]) > 12)) {
    let [, h1, m1, p1, h2, m2, p2] = m;
    if (!p1 && p2) p1 = p2;
    if (!p2 && p1) p2 = p1;
    const to24 = (h, p) => { let hh = Number(h); if (p === "pm" && hh < 12) hh += 12; if (p === "am" && hh === 12) hh = 0; return hh; };
    // No meridiem at all: assume business hours (7–18) — 2 means 2pm.
    const biz = (hh) => (!p1 && hh >= 1 && hh <= 6 ? hh + 12 : hh);
    const startHour = biz(to24(h1, p1));
    const endHour = biz(to24(h2, p2));
    if (startHour < endHour || (startHour === endHour && Number(m2 ?? 0) > Number(m1 ?? 0))) {
      return { startHour, startMin: m1 ? Number(m1) : 0, endHour, endMin: m2 ? Number(m2) : 0, explicit_range: true };
    }
  }
  m = s.match(/(?:\bat\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    const to24 = (h, p) => { let hh = Number(h); if (p === "pm" && hh < 12) hh += 12; if (p === "am" && hh === 12) hh = 0; return hh; };
    const startHour = to24(m[1], m[3]);
    const startMin = m[2] ? Number(m[2]) : 0;
    return { startHour, startMin, endHour: startHour + 1, endMin: startMin, explicit_range: false };
  }
  return null;
}

/**
 * Pull an explicit day from the reply: weekday name, "tomorrow", "today", or
 * M/D. Resolved against `now` in LA. Returns YYYY-MM-DD or null.
 */
export function extractDayFromReply(body, now = new Date()) {
  const s = String(body ?? "").toLowerCase();
  const laToday = new Intl.DateTimeFormat("en-CA", { timeZone: CAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, mo, d] = laToday.split("-").map(Number);
  const addDays = (n) => {
    const dt = new Date(Date.UTC(y, mo - 1, d + n));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  };
  if (/\btomorrow\b/.test(s)) return addDays(1);
  if (/\btoday\b/.test(s)) return addDays(0);
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(s)) {
      const todayDow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      let delta = (i - todayDow + 7) % 7;
      if (delta === 0) delta = 7; // "Thursday" on a Thursday = next week
      return addDays(delta);
    }
  }
  const m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const yy = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : y;
    return `${yy}-${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  }
  return null;
}

export function windowLabel(w) {
  const part = (h, mi) => {
    const dp = h >= 12 ? "pm" : "am";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return mi ? `${hh}:${String(mi).padStart(2, "0")}${dp}` : `${hh}${dp}`;
  };
  return `${part(w.startHour, w.startMin)}-${part(w.endHour, w.endMin)}`;
}

/** True when the reply's time matches the proposed window's start. */
export function replyTimeMatchesProposal(replyWindow, proposedWindowStr) {
  const p = parseWindow(proposedWindowStr);
  if (!p || !replyWindow) return false;
  return p.startHour === replyWindow.startHour && p.startMin === replyWindow.startMin;
}

/** Any timed calendar event overlapping [start,end]? deps-stubbed in tests. */
async function calendarBusy(startIso, endIso, deps = {}) {
  const listFn = deps.calendarListEvents ?? (await loadCalendar()).calendarListEvents;
  try {
    const res = await listFn({ time_min: startIso, time_max: endIso, max_results: 20 });
    const text = (res?.content || []).map((c) => c.text || "").join("\n");
    return /^ID:\s*\S+/m.test(text);
  } catch {
    return null; // unknown — treat as busy so we never auto-accept blind
  }
}

/**
 * Build the gated counter-reply draft. When the insured named a concrete
 * day+time and the calendar is free there, accept it; otherwise propose the
 * next opening from the slot picker. Returns { draft_text, accepted } or
 * null when we couldn't produce a sensible draft (caller falls back to a
 * plain ntfy).
 */
export async function draftCounterReply(entry, inboundBody, now = new Date(), deps = {}) {
  const time = extractTimeFromReply(inboundBody);
  const day = extractDayFromReply(inboundBody, now)
    ?? (time ? entry.proposed_date_iso : null);
  const first = (entry.contact_name || "").split(/\s+/)[0] || "there";

  if (time && day) {
    const { start, end } = buildEventTimes(day, windowLabel(time), CAL_TZ);
    if (new Date(start).getTime() > now.getTime()) {
      const busy = await calendarBusy(start, end, deps);
      if (busy === false) {
        return {
          draft_text: `Hi ${first}. ${windowLabel(time)} works — you're on my schedule. See you then.`,
          accepted: { date_iso: day, window: windowLabel(time) },
        };
      }
    }
  }

  // Their time doesn't work (busy/past/unparseable) → offer the next opening.
  const lossAddress = (entry.claim_context || {}).loss_address;
  if (!lossAddress) return null;
  try {
    const pickFn = deps.pickInspectionSlots ?? (await loadSlotPicker()).pickInspectionSlots;
    const picked = await pickFn({ loss_address: lossAddress, max_slots: 1 });
    if (!picked.ok || !picked.slots?.length) return null;
    const s = picked.slots[0];
    return {
      draft_text: `Hi ${first}. Unfortunately that time doesn't work on my end. The next opening I have is ${s.weekday} ${s.date} between ${s.start_label}-${s.end_label}. Would that work?`,
      accepted: null,
      offered: { date_iso: s.date, start: s.start, end: s.end },
    };
  } catch {
    return null;
  }
}

/**
 * Push a counter-reply draft into the outbox approval gate (one open
 * counter_reply per claim). Returns the proposal id or null.
 */
export function queueCounterReply(entry, counter, inboundBody) {
  const outbox = loadOutbox();
  const ctx = entry.claim_context || {};
  const claimKey = ctx.file_number ?? entry.claim_id ?? entry.contact_phone;
  if (findOpenProposal(outbox, claimKey, "counter_reply")) return null;
  const p = addProposal(outbox, {
    kind: "counter_reply",
    insured_name: entry.contact_name,
    to_phone: entry.contact_phone,
    thread_id: entry.thread_id,
    draft_text: counter.draft_text,
    slots: counter.offered ? [{ start: counter.offered.start, end: counter.offered.end, date: counter.offered.date_iso, label: `${counter.offered.date_iso}` }] : [],
    accepted_slot: counter.accepted ?? null,
    inbound_quote: String(inboundBody ?? "").slice(0, 300),
    claim: {
      ia_firm: ctx.ia_firm ?? entry.ia_firm ?? null,
      company_index: ctx.company_index ?? entry.company_index ?? null,
      ft_internal_claim_id: ctx.ft_internal_claim_id ?? null,
      file_number: ctx.file_number ?? entry.claim_id ?? null,
      loss_address: ctx.loss_address ?? null,
      queststar_row_id: ctx.queststar_row_id ?? null,
      first_contact_on_send: false, // first text already went out
    },
    claim_context: ctx,
    tracker_entry_id: entry.id ?? null,
  });
  saveOutbox(outbox);
  return p.id;
}

/**
 * Queue the gated "agreed to re-inspection" CMS note (kind=cms_note in the
 * outbox — the runner posts it to FileTrac ONLY after Hakiel approves,
 * always visible_to_client:false). One open note per claim.
 */
export function queueReinspectionNote(entry) {
  const ctx = entry.claim_context || {};
  const outbox = loadOutbox();
  const claimKey = ctx.file_number ?? entry.claim_id ?? entry.contact_phone;
  if (findOpenProposal(outbox, claimKey, "cms_note")) return null;
  const when = `${entry.proposed_date_iso}${entry.proposed_time_window ? " " + entry.proposed_time_window : ""}`;
  const p = addProposal(outbox, {
    kind: "cms_note",
    insured_name: entry.contact_name,
    to_phone: entry.contact_phone,
    draft_text: `Agreed to re-inspection appointment on ${when}.`,
    slots: [],
    claim: {
      ia_firm: ctx.ia_firm ?? entry.ia_firm ?? null,
      company_index: ctx.company_index ?? entry.company_index ?? null,
      ft_internal_claim_id: ctx.ft_internal_claim_id ?? null,
      file_number: ctx.file_number ?? entry.claim_id ?? null,
      first_contact_on_send: false,
    },
    claim_context: ctx,
    tracker_entry_id: entry.id ?? null,
  });
  saveOutbox(outbox);
  ntfyPublish({
    topic: APPROVALS_TOPIC,
    title: `Approval needed - CMS note for ${entry.contact_name}`,
    body: `Re-inspection agreed. Proposed FileTrac note (visible_to_client: false):\n\n"${p.draft_text}"\n\nsend ${p.id} | edit ${p.id}: <text> | skip ${p.id}`,
    priority: "high", tags: "memo",
  }).catch(() => {});
  return p.id;
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
    let intent = classify(last.body);

    // Confirmed-at-a-different-time reconciliation: "10-10:30 works" against a
    // proposed 10:30-11:30. An explicit full range on the SAME day → adopt
    // their window and proceed as CONFIRM (Planned Inspection Date is the
    // day, which is unchanged). A different DAY, or a bare single time that
    // doesn't match the proposal → counter-offer path.
    if (intent === "CONFIRM") {
      const replyTime = extractTimeFromReply(last.body);
      const replyDay = extractDayFromReply(last.body, new Date(now));
      const dayDiffers = replyDay && entry.proposed_date_iso && replyDay !== entry.proposed_date_iso;
      if (dayDiffers) {
        intent = "COUNTER";
      } else if (replyTime && !replyTimeMatchesProposal(replyTime, entry.proposed_time_window)) {
        if (replyTime.explicit_range) {
          entry.proposed_time_window = windowLabel(replyTime);
          entry.window_adjusted_from_reply = true;
        } else {
          intent = "COUNTER";
        }
      }
    }

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

    // C3: CMS + Queststar write-backs on CONFIRM. Pre-authorized by the
    // approval of the outbound SMS (prompt disclosed them). Once-only +
    // only-if-empty guards live inside; re-inspections are no-ops.
    let ftLine = "", qsLine = "";
    if (intent === "CONFIRM") {
      try { ftLine = `\n${await (deps.writeInspectionDate ?? writeInspectionDate)(entry, deps)}`; }
      catch (e) { ftLine = `\nFT date: WRITE FAILED (${String(e.message).slice(0, 100)}) — set manually`; }
      try { qsLine = `\n${await (deps.updateQueststarOnConfirm ?? updateQueststarOnConfirm)(entry, deps)}`; }
      catch (e) { qsLine = `\nQueststar: update failed (${String(e.message).slice(0, 100)})`; }
      // Re-inspection agreements land as a GATED CMS note (never auto-posted —
      // standing no-auto-notes rule). Queue it for approval on the outbox.
      if ((entry.claim_context || {}).kind === "reinspection" && !DRY_RUN) {
        try {
          const noteId = (deps.queueReinspectionNote ?? queueReinspectionNote)(entry);
          ftLine += noteId
            ? `\nCMS note drafted as outbox #${noteId} — approve on '${APPROVALS_TOPIC}' to post (not visible to client).`
            : `\nCMS note: already awaiting approval for this claim.`;
        } catch (e) {
          ftLine += `\nCMS note: draft failed (${String(e.message).slice(0, 80)})`;
        }
      }
    }

    // C4: counter-offer / unclear → gated reply draft in the outbox.
    let counterLine = "";
    if (intent === "COUNTER" || intent === "UNCLEAR") {
      try {
        const counter = await (deps.draftCounterReply ?? draftCounterReply)(entry, last.body, new Date(now), deps);
        if (counter && !DRY_RUN) {
          const pid = (deps.queueCounterReply ?? queueCounterReply)(entry, counter, last.body);
          counterLine = pid
            ? `\nDraft reply queued as outbox #${pid} — approve on '${APPROVALS_TOPIC}' (send ${pid} | edit ${pid}: <text> | skip ${pid}):\n"${counter.draft_text}"`
            : `\nA counter-reply draft is already awaiting your approval for this claim.`;
        } else if (counter && DRY_RUN) {
          counterLine = `\n[dry-run] would queue reply draft: "${counter.draft_text}"`;
        } else {
          counterLine = `\nCould not auto-draft a reply — handle the thread manually.`;
        }
      } catch (e) {
        counterLine = `\nCounter-draft error: ${String(e.message).slice(0, 100)} — handle manually.`;
      }
    }

    const ntfyTitle = `SMS reply from ${entry.contact_name} — ${intent}`;
    const ntfyBody = [
      `Claim: ${entry.claim_id || "?"} (${entry.ia_firm || "?"})`,
      `Contact: ${entry.contact_name} (${entry.contact_phone})`,
      `Reply (${fmtPST(last.timestamp_iso)}): ${last.body}`,
      ``,
      intent === "CONFIRM"
        ? `Confirmed for ${dateLabel}${window}.${entry.window_adjusted_from_reply ? " (window adjusted to their reply)" : ""}${calLine}${ftLine}${qsLine}`
        : intent === "DECLINE"
          ? `They can't make ${dateLabel}${window} — your move (call or re-propose).`
          : `${intent === "COUNTER" ? "They proposed a different time." : "Unclear reply."}${counterLine}`,
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
