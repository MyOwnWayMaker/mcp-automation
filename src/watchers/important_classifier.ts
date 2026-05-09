/**
 * "Outside the adjuster path" importance classifier.
 *
 * Runs as the LAST stage in the inbound-email matcher chain, AFTER the
 * adjuster matchers (HIGH/CORRECTION/MEDIUM in claim_monitor.ts) have already
 * either tagged the email or returned null. If they returned null, we still
 * may have something Hakiel cares about — grant-writer asks, tax/CPA notices,
 * legal letters, banking alerts, regulatory filings, personal contacts asking
 * for signatures. This classifier surfaces those as `[IMPORTANT][{category}]`
 * ntfy alerts on the same dino-claims-alerts-fpx topic.
 *
 * Three layers, in order:
 *   1. Marketing pre-filter — drop without alerting (cost control, noise control)
 *   2. Hard-allowlist fast-path — known senders Hakiel always wants to see;
 *      bypass the LLM verdict but still call Gemini for a useful 1-line summary
 *   3. LLM importance classifier (Gemini 2.0 Flash) — the safety net
 *
 * Constraints:
 *   - No auto-reply (alert-only, like SUPP/REINSP/CORRECTION)
 *   - One alert per email
 *   - Skip emails the adjuster matchers already tagged (caller enforces)
 *   - Skip LLM on bodies <200 chars
 *   - Fail-open on Gemini error (better to over-alert than miss)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Types ───────────────────────────────────────────────────────────────────

export type ImportantCategory =
  | "tax"
  | "legal"
  | "grant_or_funding"
  | "banking_finance"
  | "regulatory_or_govt"
  | "personal_signed_doc"
  | "professional_question"
  | "deadline_notice"
  | "business_admin"
  | "other_important"
  | "not_important";

export type ImportantVerdict = {
  is_important: boolean;
  confidence: number;
  category: ImportantCategory;
  summary: string;
  action_hint: string;
  deadline: string | null;
  source: "marketing_filter" | "hard_allowlist" | "llm" | "fail_open";
};

// ── Layer 1: Marketing pre-filter ───────────────────────────────────────────

// Known marketing-sender domains. Match by exact domain, suffix, or substring
// in the From header. Inclusive — easier to add than to define a precise
// "is this marketing" rule. Hakiel can edit this list as new noisy senders
// surface.
const MARKETING_DOMAINS = [
  "eventbrite.com",
  "wingspan.app",
  "insta360.com",
  "sixt.com",
  "parallels.com",
  "zapier.com",
  "wispr.ai",
  "skip.com",
  "grantmasterychallenge.com",
  "galaxyofstars.com",
  "skysthelimit.org",
  "circle.so",       // Adjuster University posts
  "renfroe.com",     // newsletter
  "intuit.com",      // marketplace marketing (not transactional)
  "summit@pinkprint.net",  // Pink Print summit blasts (note: tye@/info@/stormi@ are allowlisted separately)
  "marketing@pinkprint.net",
];

// Subject regex tells. Loose intentionally — false positives here just mean
// the email falls through to the LLM, which can still flag it.
const MARKETING_SUBJECT_RE = /(% off|sale ends|ends in|trial ending|newsletter|webinar|summit happening|sale|🎉|don't miss|last chance|early bird|free trial|special offer|limited time)/i;

// Senders that often look like marketing but have transactional traffic too.
// For these, only filter when subject matches marketing keywords AND none of
// the transactional-tells appear.
const TRANSACTIONAL_TELLS_RE = /(past due|payment failed|missed.+payment|fraud alert|wire|deposit hold|return|refund|invoice|receipt|account locked|verify your|tax document|1099|w-9)/i;

export function isObviousMarketing(args: {
  from: string;
  subject: string;
  has_unsubscribe: boolean;
}): boolean {
  const fromLower = (args.from || "").toLowerCase();
  const subjectLower = (args.subject || "").toLowerCase();

  // Strong signal: List-Unsubscribe header + sender on marketing list
  if (args.has_unsubscribe) {
    for (const dom of MARKETING_DOMAINS) {
      if (fromLower.includes(dom)) {
        // But check: is this a transactional subject? If so, NOT marketing.
        if (TRANSACTIONAL_TELLS_RE.test(subjectLower)) return false;
        return true;
      }
    }
  }

  // Subject screams marketing
  if (MARKETING_SUBJECT_RE.test(subjectLower)) {
    if (TRANSACTIONAL_TELLS_RE.test(subjectLower)) return false;
    return true;
  }

  // noreply senders without transactional tells
  if (/^(no[-_]?reply|donotreply|notifications?)@/i.test(fromLower) ||
      /<\s*(no[-_]?reply|donotreply|notifications?)@/i.test(fromLower)) {
    if (!TRANSACTIONAL_TELLS_RE.test(subjectLower)) return true;
  }

  return false;
}

// ── Layer 2: Hard allowlist ─────────────────────────────────────────────────

// Senders Hakiel always wants to see, regardless of subject. Each entry is
// either an exact email, a domain-suffix wildcard `*@domain.com`, or a
// subdomain-wildcard `*.domain.com` (matches anything ending in `.domain.com`
// after the @). Add new entries here without redeploy concerns — they're
// just data.
const HARD_ALLOWLIST: string[] = [
  // Tax / accounting
  "*@phoenixfinancialgroup.com",
  "*@carltondennis.com",
  "*@irs.gov",
  "*.irs.gov",
  "*@ftb.ca.gov",
  "*@boe.ca.gov",
  "*@edd.ca.gov",
  "*@ca.gov",
  "quickbooks@notification.intuit.com",
  "*@stripe.com",
  // Grant writer
  "tye@pinkprint.net",
  "info@pinkprint.net",
  "stormibanks@pinkprint.net",
  // Banking transactional
  "*@notifications.usbank.com",
  // Personal contacts that have asked for signatures historically
  "katlowe75@gmail.com",
  "davy.ogdave@gmail.com",
];

function extractEmailAddress(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

export function matchesHardAllowlist(fromHeader: string): boolean {
  const addr = extractEmailAddress(fromHeader);
  if (!addr) return false;
  const at = addr.indexOf("@");
  if (at < 0) return false;
  const domain = addr.substring(at + 1);

  for (const entry of HARD_ALLOWLIST) {
    const e = entry.toLowerCase();
    if (e === addr) return true;
    if (e.startsWith("*@")) {
      const wantDom = e.substring(2);
      if (domain === wantDom) return true;
    }
    if (e.startsWith("*.")) {
      const wantSuffix = e.substring(1); // ".irs.gov"
      if (domain.endsWith(wantSuffix)) return true;
      // Also match exact-domain (gov.uk → *.gov.uk should match emails @gov.uk)
      if (domain === wantSuffix.substring(1)) return true;
    }
  }
  return false;
}

// ── Layer 3: LLM classifier ─────────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are an importance triage classifier for an independent insurance adjuster's
personal inbox. The user already has automated alerts for adjuster-side claim
work (new assignments, supplements, re-inspections, examiner corrections, notary
work). Your job is to flag emails OUTSIDE that workflow that look personally
important or time-sensitive — things he would regret missing.

Return STRICT JSON only, no prose, no markdown:
{
  "is_important": true|false,
  "confidence": 0.0-1.0,
  "category": "tax" | "legal" | "grant_or_funding" | "banking_finance" | "regulatory_or_govt" | "personal_signed_doc" | "professional_question" | "deadline_notice" | "business_admin" | "other_important" | "not_important",
  "summary": "one-sentence what this email is",
  "action_hint": "one short clause about what the recipient should do",
  "deadline": "YYYY-MM-DD or null"
}

Flag as important (is_important=true) if ANY are true:
- Sender appears to be a real human writing personally (not template/automation), AND the message asks a question, requests action, or shares a status update that requires the recipient to do something
- Sender is or could plausibly be a known professional contact: CPA, attorney, banker, grant writer, business advisor, government agency caseworker, landlord/property manager, regulator, licensing board, contracted vendor on a real engagement
- Body mentions: tax, IRS, FTB, EDD, 1099, W-9, audit, estimated payment, tax notice, return; OR grant, funding, RFP, LOI, application, award, proposal revision; OR signed document, signature requested, contract, NDA, non-waiver, tender, demand letter; OR deadline, due by, expires, must respond, final notice; OR money owed/owing, past due, payment failed, wire, ACH return, deposit hold, fraud alert; OR license renewal, certification, cert expires, regulatory filing, state filing, BOE/SOS notice
- Tone is direct/personal ("Hi Hakiel, ...", "Can you ...?") not broadcast ("Don't miss our sale!")

Do NOT flag as important if:
- It is marketing, newsletters, product announcements, sales reminders, webinar invites, "summit happening now"-style copy, even if the sender is someone he's done business with
- It is a routine system notification with no asked action (Zelle "payment is on its way", Climate Data Online "request submitted", privacy policy updates, "your trial ends in N days" without a real obligation)
- It is already an adjuster-pattern email — those are handled elsewhere

Be biased toward flagging when uncertain on:
- Personal-sounding emails from individuals you don't recognize
- Anything with "deadline", "respond by", "final notice", or a date in the next 14 days
- Emails referencing money, contracts, signatures, government agencies`;

const SUMMARY_PROMPT = `You are summarizing an email for a 1-line phone notification. Be concise and concrete.

Return STRICT JSON only:
{
  "category": "tax" | "legal" | "grant_or_funding" | "banking_finance" | "regulatory_or_govt" | "personal_signed_doc" | "professional_question" | "deadline_notice" | "business_admin" | "other_important",
  "summary": "one-sentence what this email is",
  "action_hint": "one short clause about what the recipient should do",
  "deadline": "YYYY-MM-DD or null"
}`;

function getGenAI(): GoogleGenerativeAI | null {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) return null;
  return new GoogleGenerativeAI(key);
}

function tryParseJson(s: string): any | null {
  // Gemini sometimes wraps JSON in ```json ... ``` fences. Strip them.
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

function buildEmailContext(args: { from: string; subject: string; date: string; body: string }): string {
  // Strip HTML tags + collapse whitespace + cap at 2500 chars (cost control).
  const cleanBody = (args.body || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 2500);

  return `EMAIL:
From: ${args.from}
Subject: ${args.subject}
Date: ${args.date}
Body (first 2500 chars):
${cleanBody}`;
}

async function llmClassify(args: {
  from: string;
  subject: string;
  date: string;
  body: string;
}): Promise<ImportantVerdict> {
  const genAI = getGenAI();
  if (!genAI) {
    console.error("[important-classifier] GOOGLE_AI_API_KEY not set; failing open as important.");
    return {
      is_important: true,
      confidence: 0.5,
      category: "other_important",
      summary: "Could not classify (no Gemini key).",
      action_hint: "Review manually.",
      deadline: null,
      source: "fail_open",
    };
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: { temperature: 0.15 },
  });

  const fullPrompt = `${CLASSIFIER_PROMPT}\n\n${buildEmailContext(args)}`;

  // Try once, retry once with explicit JSON-only reminder, then fail-open.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = attempt === 1
        ? fullPrompt
        : `${fullPrompt}\n\nIMPORTANT: respond ONLY with the JSON object. No prose, no markdown fences.`;
      const res = await model.generateContent(prompt);
      const text = res.response.text();
      const parsed = tryParseJson(text);
      if (parsed && typeof parsed.is_important === "boolean") {
        return {
          is_important: !!parsed.is_important,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          category: (parsed.category as ImportantCategory) || "other_important",
          summary: String(parsed.summary || "").substring(0, 280),
          action_hint: String(parsed.action_hint || "").substring(0, 200),
          deadline: parsed.deadline && parsed.deadline !== "null" ? String(parsed.deadline) : null,
          source: "llm",
        };
      }
      console.error(`[important-classifier] Gemini malformed JSON on attempt ${attempt}: ${text.substring(0, 200)}`);
    } catch (e: any) {
      console.error(`[important-classifier] Gemini error on attempt ${attempt}: ${e?.message || e}`);
    }
  }

  // Fail-open: better to over-alert than miss. Confidence dropped to flag uncertainty.
  return {
    is_important: true,
    confidence: 0.4,
    category: "other_important",
    summary: "Classifier failed — review manually.",
    action_hint: "Open + skim.",
    deadline: null,
    source: "fail_open",
  };
}

async function llmSummarizeOnly(args: {
  from: string;
  subject: string;
  date: string;
  body: string;
}): Promise<ImportantVerdict> {
  // For hard-allowlist hits we already know it's important; still call Gemini
  // for a useful 1-line summary so the ntfy push isn't just "[IMPORTANT] {subject}".
  const genAI = getGenAI();
  if (!genAI) {
    return {
      is_important: true,
      confidence: 1.0,
      category: "other_important",
      summary: args.subject || "(no subject)",
      action_hint: "Open + review.",
      deadline: null,
      source: "hard_allowlist",
    };
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: { temperature: 0.15 },
  });

  const fullPrompt = `${SUMMARY_PROMPT}\n\n${buildEmailContext(args)}`;

  try {
    const res = await model.generateContent(fullPrompt);
    const text = res.response.text();
    const parsed = tryParseJson(text);
    if (parsed && parsed.summary) {
      return {
        is_important: true,
        confidence: 1.0,
        category: (parsed.category as ImportantCategory) || "other_important",
        summary: String(parsed.summary).substring(0, 280),
        action_hint: String(parsed.action_hint || "Open + review.").substring(0, 200),
        deadline: parsed.deadline && parsed.deadline !== "null" ? String(parsed.deadline) : null,
        source: "hard_allowlist",
      };
    }
  } catch (e: any) {
    console.error(`[important-classifier] summary Gemini error: ${e?.message || e}`);
  }

  return {
    is_important: true,
    confidence: 1.0,
    category: "other_important",
    summary: args.subject || "(no subject)",
    action_hint: "Open + review.",
    deadline: null,
    source: "hard_allowlist",
  };
}

// ── Public orchestration ────────────────────────────────────────────────────

export async function classifyImportant(args: {
  from: string;
  subject: string;
  date: string;
  body: string;
  has_unsubscribe: boolean;
}): Promise<ImportantVerdict | null> {
  // Layer 1: marketing pre-filter
  if (isObviousMarketing(args)) {
    console.log(`[important-classifier] DROP (marketing) — ${args.from} — ${args.subject}`);
    return null;
  }

  // Layer 2: hard allowlist fast-path (skip LLM judgment, still summarize)
  if (matchesHardAllowlist(args.from)) {
    const verdict = await llmSummarizeOnly(args);
    console.log(`[important-classifier] HARD-ALLOWLIST [${verdict.category}] — ${args.from} — ${args.subject}`);
    return verdict;
  }

  // Layer 3: skip LLM on bodies that are too thin to score
  if ((args.body || "").length < 200) {
    console.log(`[important-classifier] SKIP (body <200 chars) — ${args.from} — ${args.subject}`);
    return null;
  }

  // Layer 3: LLM verdict
  const verdict = await llmClassify(args);
  console.log(`[important-classifier] LLM [${verdict.source}/${verdict.category}/conf=${verdict.confidence}] is_important=${verdict.is_important} — ${args.from} — ${args.subject}`);
  return verdict.is_important ? verdict : null;
}

// ── ntfy formatting helper ──────────────────────────────────────────────────

export function buildImportantNtfyPayload(args: {
  from: string;
  subject: string;
  verdict: ImportantVerdict;
}): { title: string; message: string } {
  const { from, subject, verdict } = args;
  // Display name — strip the email-address part if there's a quoted name
  const nameMatch = from.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  const fromDisplay = nameMatch ? nameMatch[1].trim() : from;

  const title = `[IMPORTANT][${verdict.category}] ${fromDisplay} — ${subject}`;

  const lines = [verdict.summary];
  if (verdict.action_hint) lines.push(`-> ${verdict.action_hint}`);
  if (verdict.deadline) lines.push(`Deadline: ${verdict.deadline}`);
  if (verdict.source === "fail_open") lines.push("(classifier fell through — review manually)");
  const message = lines.join("\n");

  return { title, message };
}
