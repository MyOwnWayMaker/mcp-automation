/**
 * Email text utilities for the inbound-mail watchers.
 *
 * getMatchableText() returns a single string the regex matchers should test
 * against: the subject plus the first ~1000 chars of plain-text body, with
 * HTML stripped, quoted-reply blocks removed, and whitespace normalized.
 *
 * Why: examiners and adjusters often put the trigger phrase in the body of
 * a thread with a generic subject like "Re: 1234 status". Subject-only
 * matchers miss those. Capping at 1000 chars keeps long auto-reply chains
 * from generating false positives - 1000 chars covers the first paragraph
 * or two, where the actual ask lives.
 *
 * Quoted-reply detection covers the four common patterns we see in the
 * wild:
 *   - Lines starting with "> " (classic quote)
 *   - Outlook "-----Original Message-----" block and everything after
 *   - Gmail "On <date> at <time>, <sender> wrote:" and everything after
 *   - Apple Mail "On <date>, at <time>, <sender> <<email>> wrote:" variant
 */

const BODY_CHAR_LIMIT = 1000;

// Strip HTML tags + decode common entities. Used when the email is HTML-only.
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/(div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

// Walk a Gmail payload tree and return the best plain-text representation:
// prefer text/plain anywhere in the tree; fall back to text/html with tags
// stripped. Mirrors the body extraction in src/tools/gmail.ts but lives
// standalone so watchers can import it without pulling in MCP types.
export function extractPlainTextBody(payload: any): string {
  if (!payload) return "";

  // Direct body on this node.
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf-8");
    if (payload.mimeType === "text/html") return stripHtml(decoded);
    return decoded;
  }

  const parts: any[] = payload.parts ?? [];

  // Prefer text/plain anywhere in the tree.
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
  }

  // Recurse into multipart/* containers.
  for (const part of parts) {
    if (part.mimeType?.startsWith("multipart/")) {
      const found = extractPlainTextBody(part);
      if (found) return found;
    }
  }

  // Fall back to text/html.
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const html = Buffer.from(part.body.data, "base64").toString("utf-8");
      return stripHtml(html);
    }
  }

  return "";
}

// Strip quoted-reply blocks. Handles the four common email client patterns.
// Order matters: cut the earliest separator we find.
export function stripQuotedReply(text: string): string {
  if (!text) return "";

  // Find the earliest occurrence of any quote-block separator.
  const cutPatterns: RegExp[] = [
    // Outlook
    /^[ \t]*-----+\s*Original Message\s*-----+/im,
    /^[ \t]*-----+\s*Forwarded Message\s*-----+/im,
    // Gmail "On {date} at {time}, {sender} wrote:" - one or more lines, ends with "wrote:"
    /^[ \t]*On\s+.{1,200}\bwrote:\s*$/im,
    // Apple Mail "On {date}, at {time}, {sender} <{email}> wrote:"
    /^[ \t]*On\s+.{1,80},\s*at\s+.{1,40}\bwrote:\s*$/im,
    // Generic "From: <name>" block (Outlook reply header without dashes)
    /^[ \t]*From:\s+.{1,200}\nSent:\s+/im,
    // Microsoft "________________________________" separator (32+ underscores)
    /^_{20,}\s*$/m,
  ];

  let cutIndex = text.length;
  for (const pat of cutPatterns) {
    const m = pat.exec(text);
    if (m && m.index < cutIndex) cutIndex = m.index;
  }
  let trimmed = text.substring(0, cutIndex);

  // Drop lines starting with "> " (classic quote prefix). Only treat a run
  // of quoted lines as the boundary - otherwise inline ">" characters in
  // ASCII art or signatures would falsely trigger.
  const lines = trimmed.split(/\r?\n/);
  const out: string[] = [];
  let consecutiveQuoted = 0;
  for (const line of lines) {
    if (/^\s*>/.test(line)) {
      consecutiveQuoted++;
      // Once we hit 2+ quoted lines in a row, treat the rest as quote.
      if (consecutiveQuoted >= 2) break;
    } else {
      consecutiveQuoted = 0;
      out.push(line);
    }
  }
  return out.join("\n");
}

// Final shape: subject + first `charLimit` chars of cleaned body.
//
// opts.stripQuotes (default true): drop quoted-reply blocks. Set FALSE for
//   XactAnalysis "Assignment Note" notifications — their entire payload is the
//   note, which is frequently a forwarded examiner thread ("From:/Sent:/On …
//   wrote:"). Quote-stripping would delete the note itself, leaving only the
//   generic subject and forcing every supplement note to fall to [STATUS].
// opts.charLimit (default BODY_CHAR_LIMIT=1000): for the same XA notes the
//   supplement signal can sit deep in the forwarded body, so callers raise it.
export function getMatchableText(
  args: {
    subject: string;
    payload?: any;        // raw Gmail message payload
    plainBody?: string;   // pre-extracted plain text (used by tests + dry-run)
  },
  opts?: { stripQuotes?: boolean; charLimit?: number },
): string {
  const stripQuotes = opts?.stripQuotes ?? true;
  const charLimit = opts?.charLimit ?? BODY_CHAR_LIMIT;
  const subject = args.subject || "";
  const raw = args.plainBody !== undefined ? args.plainBody : extractPlainTextBody(args.payload);
  const cleaned = (stripQuotes ? stripQuotedReply(raw) : raw)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = cleaned.substring(0, charLimit);
  return body ? `${subject}\n\n${body}` : subject;
}
