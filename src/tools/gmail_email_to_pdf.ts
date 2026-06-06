/**
 * gmail_email_to_pdf — render a Gmail message as a Letter-sized PDF.
 *
 * Mirrors what Gmail's native Print → Save as PDF produces: header block with
 * From/To/Date/Subject, then the HTML body. Used by the claim-folder pipeline
 * to snapshot assignment emails / DA notes / mileage approvals into a Drive
 * folder so the inspection workspace has the full source paper trail.
 *
 * Filename defaults to subject (with `:` `|` `/` `\` replaced by `_`), so
 * "New IAnet Assignment File ID: 1395966 | Claim Number: 0622759870101038"
 * becomes "New IAnet Assignment File ID_ 1395966 _ Claim Number_ 0622759870101038.pdf".
 * Pass `filename` to override with a content-based label
 * (e.g. "Approved Mileage.pdf" for a mileage-approval notice).
 *
 * If `drive_folder_id` is set, uploads directly to that folder and returns the
 * Drive link. Otherwise returns the base64-encoded PDF for the caller to handle.
 */

import { chromium } from "playwright";
import { getGmailClient } from "./gmail.js";
import { driveUploadFile } from "./drive.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function makeTextContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Walk MIME parts to find the text/html body (preferred for PDF rendering).
function extractHtmlBody(payload: any): string | null {
  if (payload?.mimeType === "text/html" && payload?.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  const parts: any[] = payload?.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
  }
  for (const part of parts) {
    if (part.mimeType?.startsWith("multipart/")) {
      const found = extractHtmlBody(part);
      if (found) return found;
    }
  }
  return null;
}

// Fall back: plain text wrapped in <pre> so format/layout is preserved.
function extractPlainBody(payload: any): string | null {
  if (payload?.mimeType === "text/plain" && payload?.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  const parts: any[] = payload?.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
  }
  for (const part of parts) {
    if (part.mimeType?.startsWith("multipart/")) {
      const found = extractPlainBody(part);
      if (found) return found;
    }
  }
  return null;
}

function wrapEmailForPrint(meta: { from: string; to: string; date: string; subject: string }, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(meta.subject)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 20px; color: #202124; }
  .email-header { color: #5f6368; font-size: 13px; border-bottom: 1px solid #dadce0; padding-bottom: 14px; margin-bottom: 18px; }
  .email-subject { font-size: 18px; color: #202124; font-weight: 400; margin-bottom: 12px; }
  .email-meta { margin: 4px 0; }
  .email-body { font-size: 14px; line-height: 1.45; }
  img[width="1"][height="1"] { display: none; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
</style></head>
<body>
  <div class="email-header">
    <div class="email-subject">${escapeHtml(meta.subject)}</div>
    <div class="email-meta"><strong>From:</strong> ${escapeHtml(meta.from)}</div>
    <div class="email-meta"><strong>To:</strong> ${escapeHtml(meta.to)}</div>
    <div class="email-meta"><strong>Date:</strong> ${escapeHtml(meta.date)}</div>
  </div>
  <div class="email-body">${bodyHtml}</div>
</body></html>`;
}

function defaultFilename(subject: string): string {
  const safe = subject.replace(/[:/\\|]/g, "_").trim() || "email";
  return `${safe}.pdf`;
}

export async function gmailEmailToPdf(args: {
  message_id: string;
  drive_folder_id?: string;
  filename?: string;
}): Promise<CallToolResult> {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "full",
  });

  const headers = res.data.payload?.headers ?? [];
  const getH = (name: string) =>
    headers.find((h: any) => h.name === name)?.value ?? "";

  const meta = {
    from: getH("From"),
    to: getH("To"),
    date: getH("Date"),
    subject: getH("Subject"),
  };

  let bodyHtml = extractHtmlBody(res.data.payload);
  if (!bodyHtml) {
    const plain = extractPlainBody(res.data.payload);
    if (!plain) {
      return makeTextContent(`❌ No readable body found in message ${args.message_id} — cannot render to PDF.`);
    }
    bodyHtml = `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(plain)}</pre>`;
  }

  const wrapped = wrapEmailForPrint(meta, bodyHtml);

  const browser = await chromium.launch({ headless: true });
  let pdfBase64: string;
  try {
    const page = await browser.newPage();
    await page.setContent(wrapped, { waitUntil: "domcontentloaded" });
    // Best-effort wait for fonts/inline images — external images may not load in 5s, that's fine.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    });
    pdfBase64 = pdfBuffer.toString("base64");
  } finally {
    await browser.close().catch(() => { /* swallow */ });
  }

  const filename = args.filename ?? defaultFilename(meta.subject);

  if (args.drive_folder_id) {
    const driveResult = await driveUploadFile({
      file_bytes_b64: pdfBase64,
      folder_id: args.drive_folder_id,
      name: filename,
      mime_type: "application/pdf",
    } as any);
    // driveUploadFile returns CallToolResult — pass-through and add our context
    const driveText =
      driveResult.content?.[0] && (driveResult.content[0] as any).type === "text"
        ? (driveResult.content[0] as any).text
        : "";
    return makeTextContent(
      `✅ Rendered Gmail message ${args.message_id} to PDF and uploaded to Drive.\n` +
      `Subject: ${meta.subject}\n` +
      `Filename: ${filename}\n` +
      `From: ${meta.from}\n` +
      `Date: ${meta.date}\n\n` +
      `Drive upload response:\n${driveText}`
    );
  }

  return makeTextContent(
    JSON.stringify({
      ok: true,
      message_id: args.message_id,
      subject: meta.subject,
      from: meta.from,
      date: meta.date,
      suggested_filename: filename,
      pdf_b64: pdfBase64,
    })
  );
}
