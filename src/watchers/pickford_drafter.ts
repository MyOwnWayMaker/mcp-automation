/**
 * Pickford Escrow auto-drafter.
 *
 * Fires only on [NOTARY-PICKFORD-AVAIL] / [NOTARY-PICKFORD-DOC] verdicts.
 * Creates a Gmail DRAFT (never auto-sends) on the notary thread so Hakiel
 * can review + click Send. Manual approval gate, same as the [IMPORTANT]
 * drafter for the main inbox.
 *
 * Flow:
 *   AVAIL:  Gemini extracts {date, time_window, location} from the inquiry.
 *           We pull calendar events on Hakiels main calendar that overlap
 *           a +/- 3hr window around the proposed signing. Pass everything
 *           (inquiry body + extracted appointment + calendar events + home
 *           base) to Gemini, which drafts a reply that explicitly reasons
 *           about whether he can make it - "Im wrapping up an inspection
 *           in Burbank at 5:45, can be in Englewood by 6:30 if traffic
 *           cooperates", or "I have a 7pm appointment in Sherman Oaks I
 *           cant move - could we do 5:00?"
 *
 *   DOC:    Short acknowledgment - "Got the docs, thanks. Will review and
 *           confirm the appointment shortly."
 *
 * Skip drafting when:
 *   - Hakiel already replied in this thread within 24h
 *   - LLM extraction or calendar query errors out (fail open: log + skip)
 *
 * Drive-time notes (v1 limitation):
 *   v1 has Gemini reason about distances loosely from city/neighborhood
 *   names. It will know "Englewood from Burbank at 6pm" implies ~30-50min
 *   on the 405. Future v2 should plug in Google Maps Distance Matrix for
 *   exact ETAs. Until then, flag any draft that hinges on tight timing as
 *   "needs your eyes" in the ntfy.
 */

import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getNotaryGmailClient } from "../auth/google-notary.js";
import { getGoogleAuthClient } from "../auth/google.js";

const HOME_BASE = "4470 Ventura Canyon Ave, Sherman Oaks, CA 91423";

// Signature cache (notary sendAs).
let _sigCache: { html: string; fetched_at: number } | null = null;
const SIG_TTL_MS = 60 * 60 * 1000;

async function getNotaryReplySignatureHtml(): Promise<string | null> {
  const now = Date.now();
  if (_sigCache && now - _sigCache.fetched_at < SIG_TTL_MS) return _sigCache.html;
  try {
    const auth = await getNotaryGmailClient();
    const gmail = google.gmail({ version: "v1", auth });
    const list = await gmail.users.settings.sendAs.list({ userId: "me" });
    const aliases = list.data.sendAs || [];
    const primary = aliases.find((a) => a.isPrimary) || aliases[0];
    const sig = (primary?.signature || "").trim();
    _sigCache = { html: sig, fetched_at: now };
    return sig;
  } catch (e: any) {
    console.error(`[pickford-drafter] signature fetch failed: ${e?.message || e}`);
    return null;
  }
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainToHtmlSafe(s: string): string {
  return htmlEscape(s).replace(/\n/g, "<br>");
}

// Recent-reply check: skip drafting if Hakiel already responded in thread.
async function repliedInThreadRecently(threadId: string, withinMs = 24 * 60 * 60 * 1000): Promise<boolean> {
  try {
    const auth = await getNotaryGmailClient();
    const gmail = google.gmail({ version: "v1", auth });
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "Date"],
    });
    const msgs = thread.data.messages || [];
    const cutoff = Date.now() - withinMs;
    for (const msg of msgs) {
      const headers = msg.payload?.headers || [];
      const fromHdr = (headers.find((h) => h.name === "From")?.value || "").toLowerCase();
      const internalDate = parseInt(msg.internalDate || "0", 10);
      if (fromHdr.includes("drupenterprise1@gmail.com") && internalDate >= cutoff) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // fail open - allow drafting
  }
}

// Gemini setup
function getGenAI(): GoogleGenerativeAI | null {
  const key = process.env.GOOGLE_AI_API_KEY;
  return key ? new GoogleGenerativeAI(key) : null;
}

function tryParseJson(s: string): any | null {
  let cleaned = s.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// Step 1 of AVAIL flow: extract appointment details.
type Appointment = {
  date_iso: string | null;       // YYYY-MM-DD or null if ambiguous
  time_start_24h: string | null; // HH:MM (24h)
  time_end_24h: string | null;
  location_text: string | null;  // free-form: "Englewood", "2800 Veteran Ave LA", etc.
  duration_min: number;          // typical loan signing: 60min
};

async function extractAppointment(args: {
  subject: string;
  body: string;
  email_received_iso: string;
}): Promise<Appointment | null> {
  const genAI = getGenAI();
  if (!genAI) return null;
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.1 },
  });
  const prompt = `Extract notary signing appointment details from the email below.
The recipient is a notary signing agent in Los Angeles. Return STRICT JSON only:
{
  "date_iso": "YYYY-MM-DD or null if not stated",
  "time_start_24h": "HH:MM in 24h format or null",
  "time_end_24h": "HH:MM in 24h or null (window upper bound; same as start if single time)",
  "location_text": "address, city, neighborhood, or any location mentioned",
  "duration_min": 60
}

Date resolution rules:
- "tonight" or "today" -> use the date the email was received (provided below)
- "tomorrow" -> received_date + 1
- "Friday" / "next Tuesday" / etc -> resolve to the next occurrence of that weekday after received_date
- If no date is stated at all, return null for date_iso

Time rules:
- "around 6:30 - 7:00 pm" -> time_start_24h="18:30", time_end_24h="19:00"
- "at 5pm" -> time_start_24h="17:00", time_end_24h="17:00"
- If only "evening" / "afternoon" with no specific time, return null for both

EMAIL_RECEIVED: ${args.email_received_iso}
SUBJECT: ${args.subject}
BODY:
${args.body.substring(0, 1500)}`;
  try {
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const parsed = tryParseJson(text);
    if (!parsed) return null;
    return {
      date_iso: parsed.date_iso || null,
      time_start_24h: parsed.time_start_24h || null,
      time_end_24h: parsed.time_end_24h || parsed.time_start_24h || null,
      location_text: parsed.location_text || null,
      duration_min: typeof parsed.duration_min === "number" ? parsed.duration_min : 60,
    };
  } catch (e: any) {
    console.error(`[pickford-drafter] appointment extract failed: ${e?.message || e}`);
    return null;
  }
}

// Pull calendar events that overlap a +/- 3hr window around the proposed
// signing. Uses Hakiels main Google account (calendar lives there).
type CalEvent = {
  summary: string;
  start_iso: string;
  end_iso: string;
  location: string;
};

async function getCalendarContext(args: {
  date_iso: string;
  time_start_24h: string;
  time_end_24h: string;
}): Promise<CalEvent[] | null> {
  try {
    const auth = await getGoogleAuthClient();
    const cal = google.calendar({ version: "v3", auth });
    const startDt = new Date(`${args.date_iso}T${args.time_start_24h}:00`);
    const endDt = new Date(`${args.date_iso}T${args.time_end_24h}:00`);
    const windowStart = new Date(startDt.getTime() - 3 * 60 * 60 * 1000);
    const windowEnd = new Date(endDt.getTime() + 3 * 60 * 60 * 1000);
    const res = await cal.events.list({
      calendarId: "primary",
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items || []).map((e) => ({
      summary: e.summary || "(untitled)",
      start_iso: e.start?.dateTime || e.start?.date || "",
      end_iso: e.end?.dateTime || e.end?.date || "",
      location: e.location || "",
    }));
  } catch (e: any) {
    console.error(`[pickford-drafter] calendar query failed: ${e?.message || e}`);
    return null;
  }
}

// Step 2 of AVAIL flow: draft a reply that reasons about feasibility.
async function draftReplyForAvail(args: {
  inquiry_subject: string;
  inquiry_body: string;
  appointment: Appointment;
  calendar: CalEvent[];
}): Promise<{ reply: string; confidence: "high" | "medium" | "low"; verdict: "yes" | "no" | "counter" } | null> {
  const genAI = getGenAI();
  if (!genAI) return null;
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.3 },
  });

  const calLines = args.calendar.length
    ? args.calendar.map((e) => `- ${e.summary} | ${e.start_iso} -> ${e.end_iso}${e.location ? ` | LOC: ${e.location}` : ""}`).join("\n")
    : "(no events on calendar in the surrounding window)";

  const prompt = `You are drafting a reply on behalf of Hakiel McQueen, a notary signing
agent based at ${HOME_BASE} (Sherman Oaks, CA). An escrow company (Pickford Escrow)
just emailed asking if he can do a signing.

Decide whether he can make it based on his calendar around the proposed time.
Reason about LA-area drive times loosely - you know that Sherman Oaks to
Englewood is ~30-45 min, downtown to the valley is ~25-40 min, etc. Use
common sense, but flag in your reply if the gap is tight.

If the calendar shows an event before the signing with a location, treat that
as where Hakiel is coming from. If nothing is scheduled, assume hes coming from
home (${HOME_BASE}).

Return STRICT JSON only:
{
  "verdict": "yes" | "no" | "counter",
  "confidence": "high" | "medium" | "low",
  "reply": "REPLY BODY ONLY - see strict rules below"
}

CRITICAL - reply rules:
- BODY ONLY. NO greeting line ("Hi Rochelle", "Hello"), NO closing ("Thanks", "Best"), NO signature.
  The system appends Hakiels Gmail signature automatically.
- 2-4 sentences. Concrete, friendly, professional.
- If verdict is "yes": confirm clearly. If timing is tight, mention what hes coming from
  ("Im wrapping up an inspection in Burbank at 5:45, should be there by 6:30").
- If verdict is "no": say so politely, give the reason briefly ("I have a prior
  appointment in Pasadena until 7pm"), and propose a counter if possible.
- If verdict is "counter": offer an alternative time that fits his calendar.
- Never invent commitments. Never promise a specific arrival time tighter than
  20 minutes; use ranges ("between 6:30 and 6:45").

INQUIRY SUBJECT: ${args.inquiry_subject}
INQUIRY BODY (first 1500 chars):
${args.inquiry_body.substring(0, 1500)}

PROPOSED SIGNING:
  Date: ${args.appointment.date_iso}
  Time: ${args.appointment.time_start_24h} - ${args.appointment.time_end_24h}
  Location: ${args.appointment.location_text}
  Estimated duration: ${args.appointment.duration_min} min

HAKIELS CALENDAR (events within 3hr window before+after signing):
${calLines}`;

  try {
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const parsed = tryParseJson(text);
    if (!parsed?.reply) return null;
    return {
      reply: String(parsed.reply).trim(),
      confidence: (parsed.confidence as any) || "medium",
      verdict: (parsed.verdict as any) || "yes",
    };
  } catch (e: any) {
    console.error(`[pickford-drafter] reply draft failed: ${e?.message || e}`);
    return null;
  }
}

function defaultDocAcknowledgment(): string {
  return "Got the docs, thanks. I will review them now and confirm the appointment details shortly.";
}

// MIME assembly + draft creation on the notary client.
function buildMimeMessage(args: {
  to: string;
  cc?: string;
  subject: string;
  in_reply_to?: string;
  references?: string;
  body_text: string;
  body_html: string;
}): string {
  const boundary = "----=_Part_" + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
  const headerLines = [
    `To: ${args.to}`,
    args.cc ? `Cc: ${args.cc}` : "",
    `Subject: ${args.subject}`,
    args.in_reply_to ? `In-Reply-To: ${args.in_reply_to}` : "",
    args.references ? `References: ${args.references}` : "",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const bodyLines = [
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    args.body_text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    args.body_html,
    "",
    `--${boundary}--`,
    "",
  ];
  return headerLines.concat(bodyLines).join("\r\n");
}

// Audit log (first 5 drafts).
const REPO_ROOT = (() => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "../..");
})();
const AUDIT_LOG_PATH = path.join(REPO_ROOT, "logs", "pickford_drafts_audit.jsonl");
const AUDIT_VERBOSE_LIMIT = 5;
let _auditCount = 0;

function appendAuditLog(entry: Record<string, any>) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (e: any) {
    console.error(`[pickford-drafter] audit log write failed: ${e?.message || e}`);
  }
}

// Public entry point
export type PickfordDraftResult = {
  status: "drafted" | "skipped_active_thread" | "skipped_no_extraction" | "failed";
  draft_id?: string;
  reason?: string;
  signature_appended?: boolean;
  verdict?: "yes" | "no" | "counter";
  confidence?: "high" | "medium" | "low";
};

export type PickfordDraftRequest = {
  tier: "AVAIL" | "DOC";
  thread_id: string;
  in_reply_to_message_id: string;     // Message-ID header value (with angle brackets)
  reply_to_address: string;           // Rochelles address from From header
  cc_addresses?: string;
  original_subject: string;
  inquiry_body: string;
  email_received_iso: string;
  source_email_id: string;
};

export async function createPickfordDraft(req: PickfordDraftRequest): Promise<PickfordDraftResult> {
  if (await repliedInThreadRecently(req.thread_id)) {
    return { status: "skipped_active_thread", reason: "Hakiel already replied in this thread within 24h" };
  }

  let replyBody: string;
  let verdict: "yes" | "no" | "counter" | undefined;
  let confidence: "high" | "medium" | "low" | undefined;

  if (req.tier === "DOC") {
    replyBody = defaultDocAcknowledgment();
  } else {
    // AVAIL path
    const appointment = await extractAppointment({
      subject: req.original_subject,
      body: req.inquiry_body,
      email_received_iso: req.email_received_iso,
    });
    if (!appointment || !appointment.date_iso || !appointment.time_start_24h) {
      return {
        status: "skipped_no_extraction",
        reason: "Could not extract date/time from inquiry - draft a reply manually",
      };
    }
    const calendar = await getCalendarContext({
      date_iso: appointment.date_iso,
      time_start_24h: appointment.time_start_24h,
      time_end_24h: appointment.time_end_24h || appointment.time_start_24h,
    }) || [];
    const drafted = await draftReplyForAvail({
      inquiry_subject: req.original_subject,
      inquiry_body: req.inquiry_body,
      appointment,
      calendar,
    });
    if (!drafted) {
      return { status: "failed", reason: "Gemini failed to draft a reply" };
    }
    replyBody = drafted.reply;
    verdict = drafted.verdict;
    confidence = drafted.confidence;
  }

  // Append signature
  let signatureHtml: string | null = null;
  let signatureAppended = false;
  try {
    signatureHtml = await getNotaryReplySignatureHtml();
    if (signatureHtml) signatureAppended = true;
  } catch {
    /* fail open */
  }

  const subject = req.original_subject.toLowerCase().startsWith("re:")
    ? req.original_subject
    : `Re: ${req.original_subject}`;

  const bodyText = signatureHtml
    ? `${replyBody}\n\n${htmlToPlain(signatureHtml)}`
    : replyBody;
  const bodyHtml = signatureHtml
    ? `${plainToHtmlSafe(replyBody)}<br><br>${signatureHtml}`
    : plainToHtmlSafe(replyBody);

  const mime = buildMimeMessage({
    to: req.reply_to_address,
    cc: req.cc_addresses,
    subject,
    in_reply_to: req.in_reply_to_message_id,
    references: req.in_reply_to_message_id,
    body_text: bodyText,
    body_html: bodyHtml,
  });
  const raw = Buffer.from(mime).toString("base64url");

  try {
    const auth = await getNotaryGmailClient();
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          threadId: req.thread_id,
        },
      },
    });
    const draftId = res.data.id || "(unknown)";

    if (_auditCount < AUDIT_VERBOSE_LIMIT) {
      _auditCount++;
      appendAuditLog({
        timestamp: new Date().toISOString(),
        draft_id: draftId,
        thread_id: req.thread_id,
        from_orig: req.reply_to_address,
        subject_orig: req.original_subject,
        tier: req.tier,
        verdict: verdict || null,
        confidence: confidence || null,
        reply_body_chars: replyBody.length,
        signature_appended: signatureAppended,
        source_email_id: req.source_email_id,
      });
    }

    return {
      status: "drafted",
      draft_id: draftId,
      signature_appended: signatureAppended,
      verdict,
      confidence,
    };
  } catch (e: any) {
    console.error(`[pickford-drafter] draft create failed: ${e?.message || e}`);
    return { status: "failed", reason: String(e?.message || e), signature_appended: signatureAppended };
  }
}
