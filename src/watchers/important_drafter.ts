/**
 * Auto-draft Gmail replies for [IMPORTANT] alerts.
 *
 * Creates a Gmail DRAFT (never auto-sends) on the original thread when the
 * importance classifier flags an email. The LLM produces only the reply
 * body (no greeting / no closing / no signature); this module fetches
 * Hakiel's reply signature from his Gmail sendAs settings and assembles the
 * final MIME message with both text/plain and text/html alternatives so the
 * draft renders correctly on web, mobile, and 3rd-party clients.
 *
 * Why drafts and not auto-send: Hakiel reviews and approves each one — same
 * gate as SUPP/REINSP/CORRECTION. Manual send is the standing rule.
 *
 * Design notes:
 *   - Threading via In-Reply-To + References headers + Gmail threadId — keeps
 *     the draft attached to the original conversation, not orphan-threaded.
 *   - Skip drafting when Hakiel has already replied in this thread within
 *     the last 24h (he's actively managing it; an auto-draft would be noise).
 *   - Signature fetched once per process and cached for 1 hour. The Gmail
 *     sendAs API returns a single `signature` field per alias — Gmail's
 *     "different signature on reply" feature isn't separately exposed, so we
 *     use whatever's there. If only one signature is configured, this is it;
 *     Hakiel can split the variants later via Gmail Settings if he wants.
 *   - Audit log of the first 5 successful drafts in
 *     `<repo>/logs/important_drafts_audit.jsonl` for spot-checking signature
 *     handling. After 5 entries, only error-level logging stays on.
 */

import fs from "fs";
import path from "path";
import { getGmailClient } from "../tools/gmail.js";

// ── Hakiel's primary email (used for "did Hakiel reply recently" check) ─────
// Pulled from sendAs.isPrimary detection at runtime; cached.
let _primaryEmail: string | null = null;
async function primaryEmail(): Promise<string | null> {
  if (_primaryEmail) return _primaryEmail;
  try {
    const gmail = await getGmailClient();
    const profile = await gmail.users.getProfile({ userId: "me" });
    _primaryEmail = (profile.data.emailAddress || "").toLowerCase() || null;
    return _primaryEmail;
  } catch {
    return null;
  }
}

// ── Signature fetch + cache ─────────────────────────────────────────────────
// Cache for 1 hour. Gmail sendAs is a settings call (not message-rate-limited)
// but no point hammering it per-email.

let _sigCache: { html: string; fetched_at: number } | null = null;
const SIG_TTL_MS = 60 * 60 * 1000;

async function getReplySignatureHtml(): Promise<string | null> {
  const now = Date.now();
  if (_sigCache && now - _sigCache.fetched_at < SIG_TTL_MS) {
    return _sigCache.html;
  }
  try {
    const gmail = await getGmailClient();
    const list = await gmail.users.settings.sendAs.list({ userId: "me" });
    const aliases = list.data.sendAs || [];
    // Prefer primary alias's signature. If multiple primaries (shouldn't
    // happen) pick the first one with a non-empty signature.
    const primary = aliases.find(a => a.isPrimary) || aliases[0];
    const sig = (primary?.signature || "").trim();
    _sigCache = { html: sig, fetched_at: now };
    return sig;
  } catch (e: any) {
    console.error(`[important-drafter] signature fetch failed: ${e?.message || e}`);
    return null;
  }
}

// Strip HTML tags + decode common entities for plain-text alternative.
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

// Convert plain-text reply body to safe HTML — preserve paragraph breaks.
function plainToHtmlSafe(s: string): string {
  return htmlEscape(s).replace(/\n/g, "<br>");
}

// ── Recent-reply check ─────────────────────────────────────────────────────

async function hakielRepliedInThreadRecently(threadId: string, withinMs = 24 * 60 * 60 * 1000): Promise<boolean> {
  const me = await primaryEmail();
  if (!me) return false; // can't determine — fail open (allow drafting)
  try {
    const gmail = await getGmailClient();
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: ["From", "Date"] });
    const msgs = thread.data.messages || [];
    const cutoff = Date.now() - withinMs;
    for (const msg of msgs) {
      const headers = msg.payload?.headers || [];
      const fromHdr = (headers.find(h => h.name === "From")?.value || "").toLowerCase();
      const internalDate = parseInt(msg.internalDate || "0", 10);
      // Match against Hakiel's primary address; tolerant to display-name wrappers
      if (fromHdr.includes(me) && internalDate >= cutoff) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // on error, allow drafting (better to over-draft than miss)
  }
}

// ── MIME assembly + draft creation ──────────────────────────────────────────

type DraftAssembly = {
  to: string;
  cc?: string;
  subject: string;
  in_reply_to?: string;
  references?: string;
  body_text: string;
  body_html: string;
  thread_id: string;
};

function buildMimeMessage(d: DraftAssembly): string {
  // multipart/alternative with text/plain + text/html. Boundary chosen
  // simply — collisions essentially impossible for a per-message random.
  const boundary = "----=_Part_" + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);

  const headerLines = [
    `To: ${d.to}`,
    d.cc ? `Cc: ${d.cc}` : "",
    `Subject: ${d.subject}`,
    d.in_reply_to ? `In-Reply-To: ${d.in_reply_to}` : "",
    d.references ? `References: ${d.references}` : "",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const bodyLines = [
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    d.body_text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    d.body_html,
    "",
    `--${boundary}--`,
    "",
  ];

  return headerLines.concat(bodyLines).join("\r\n");
}

// ── Audit log (first 5 drafts) ──────────────────────────────────────────────

const REPO_ROOT = (() => {
  // src/watchers/* compiled to dist/watchers/* — go up two levels
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "../..");
})();
const AUDIT_LOG_PATH = path.join(REPO_ROOT, "logs", "important_drafts_audit.jsonl");
const AUDIT_VERBOSE_LIMIT = 5;
let _auditCount = 0;

function appendAuditLog(entry: Record<string, any>) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (e: any) {
    console.error(`[important-drafter] audit log write failed: ${e?.message || e}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export type DraftResult = {
  status: "drafted" | "skipped_active_thread" | "failed";
  draft_id?: string;
  reason?: string;
  signature_appended?: boolean;
};

export type DraftRequest = {
  thread_id: string;
  in_reply_to_message_id: string; // Gmail Message-ID header value (with angle brackets)
  reply_to_address: string;       // From address of the original
  cc_addresses?: string;
  original_subject: string;
  reply_body: string;             // body-only, no greeting/closing/signature (per LLM contract)
  category: string;               // for audit logging
  source_email_id: string;        // Gmail message ID (for audit log)
};

export async function createImportantDraft(req: DraftRequest): Promise<DraftResult> {
  // Skip if Hakiel has been actively replying in this thread.
  if (await hakielRepliedInThreadRecently(req.thread_id)) {
    return { status: "skipped_active_thread", reason: "Hakiel replied in this thread within 24h" };
  }

  let signature_html: string | null = null;
  let signature_appended = false;
  try {
    signature_html = await getReplySignatureHtml();
    if (signature_html) signature_appended = true;
  } catch {
    signature_html = null;
  }

  const subject = req.original_subject.toLowerCase().startsWith("re:")
    ? req.original_subject
    : `Re: ${req.original_subject}`;

  const bodyText = signature_html
    ? `${req.reply_body}\n\n${htmlToPlain(signature_html)}`
    : req.reply_body;

  const bodyHtml = signature_html
    ? `${plainToHtmlSafe(req.reply_body)}<br><br>${signature_html}`
    : plainToHtmlSafe(req.reply_body);

  const mime = buildMimeMessage({
    to: req.reply_to_address,
    cc: req.cc_addresses,
    subject,
    in_reply_to: req.in_reply_to_message_id,
    references: req.in_reply_to_message_id, // single message thread; Gmail is tolerant
    body_text: bodyText,
    body_html: bodyHtml,
    thread_id: req.thread_id,
  });

  const raw = Buffer.from(mime).toString("base64url");

  try {
    const gmail = await getGmailClient();
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
        category: req.category,
        classifier_body_chars: req.reply_body.length,
        signature_appended,
        signature_source: signature_html ? "sendAs.signature" : null,
        signature_chars: signature_html ? signature_html.length : 0,
        source_email_id: req.source_email_id,
      });
    }

    return { status: "drafted", draft_id: draftId, signature_appended };
  } catch (e: any) {
    console.error(`[important-drafter] draft create failed: ${e?.message || e}`);
    return { status: "failed", reason: String(e?.message || e), signature_appended };
  }
}
