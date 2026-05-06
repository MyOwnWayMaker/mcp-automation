import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getGmail() {
  const auth = await getGoogleAuthClient();
  return google.gmail({ version: "v1", auth });
}

function makeTextContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function encodeEmail(params: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  replyToMessageId?: string;
  threadId?: string;
}): string {
  const lines = [
    `To: ${params.to}`,
    params.from ? `From: ${params.from}` : null,
    params.cc ? `Cc: ${params.cc}` : null,
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    params.replyToMessageId ? `In-Reply-To: ${params.replyToMessageId}` : null,
    params.replyToMessageId ? `References: ${params.replyToMessageId}` : null,
    "",
    params.body,
  ]
    .filter(Boolean)
    .join("\r\n");

  return Buffer.from(lines).toString("base64url");
}

export async function gmailSendEmail(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const raw = encodeEmail(args);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return makeTextContent(`Email sent. Message ID: ${res.data.id}`);
}

export async function gmailFindEmail(args: {
  query: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: args.query,
    maxResults: args.max_results ?? 10,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) {
    return makeTextContent("No emails found matching that query.");
  }

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      })
    )
  );

  const summaries = details.map((d) => {
    const headers = d.data.payload?.headers ?? [];
    const get = (name: string) =>
      headers.find((h) => h.name === name)?.value ?? "";
    return `ID: ${d.data.id}\nFrom: ${get("From")}\nDate: ${get("Date")}\nSubject: ${get("Subject")}`;
  });

  return makeTextContent(summaries.join("\n\n---\n\n"));
}

// Recursively walk MIME parts to find the best readable body
function extractBody(payload: any): string {
  // Direct body on this node
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  const parts: any[] = payload?.parts ?? [];

  // Prefer text/plain anywhere in the tree
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
  }

  // Recurse into multipart/* containers (alternative, mixed, related, etc.)
  for (const part of parts) {
    if (part.mimeType?.startsWith("multipart/")) {
      const found = extractBody(part);
      if (found) return found;
    }
  }

  // Fall back to text/html — strip tags for readability
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const html = Buffer.from(part.body.data, "base64").toString("utf-8");
      return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  }

  return "";
}

// Recursively collect attachment metadata from a Gmail payload tree.
// A part is an attachment when it has a non-empty filename + a body.attachmentId.
type AttachmentMeta = {
  filename: string;
  mime_type: string;
  attachment_id: string;
  size_bytes: number;
};

function collectAttachments(payload: any, out: AttachmentMeta[] = []): AttachmentMeta[] {
  if (!payload) return out;
  const filename = payload.filename || "";
  const attachmentId = payload.body?.attachmentId;
  if (filename && attachmentId) {
    out.push({
      filename,
      mime_type: payload.mimeType || "application/octet-stream",
      attachment_id: attachmentId,
      size_bytes: Number(payload.body?.size ?? 0),
    });
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) collectAttachments(p, out);
  }
  return out;
}

export async function gmailGetEmail(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const res = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "full",
  });

  const headers = res.data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const body = extractBody(res.data.payload);
  const attachments = collectAttachments(res.data.payload);

  const lines = [
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Date: ${get("Date")}`,
    `Subject: ${get("Subject")}`,
    `Thread ID: ${res.data.threadId}`,
    `Message ID: ${res.data.id}`,
  ];

  if (attachments.length > 0) {
    lines.push("");
    lines.push(`Attachments (${attachments.length}):`);
    for (const a of attachments) {
      const sizeKb = a.size_bytes ? `${(a.size_bytes / 1024).toFixed(1)} KB` : "?";
      lines.push(`  - ${a.filename} (${a.mime_type}, ${sizeKb})`);
      lines.push(`    attachment_id: ${a.attachment_id}`);
    }
  }

  lines.push("");
  lines.push(body || "(no readable body found)");

  return makeTextContent(lines.join("\n"));
}

export async function gmailReplyToEmail(args: {
  message_id: string;
  body: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();

  const original = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "metadata",
    metadataHeaders: ["Subject", "From", "Message-ID"],
  });

  const headers = original.data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const subject = get("Subject").startsWith("Re:")
    ? get("Subject")
    : `Re: ${get("Subject")}`;

  const raw = encodeEmail({
    to: get("From"),
    subject,
    body: args.body,
    replyToMessageId: get("Message-ID"),
  });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: original.data.threadId! },
  });

  return makeTextContent(`Reply sent. Message ID: ${res.data.id}`);
}

export async function gmailDownloadAttachment(args: {
  message_id: string;
  attachment_id?: string;
  dest_path: string;
  drive_file_id?: string;
}): Promise<CallToolResult> {
  const destPath = path.resolve(args.dest_path);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // ── Path A: drive_file_id supplied directly ──────────────────────────────
  if (args.drive_file_id) {
    return downloadFromDrive(args.drive_file_id, destPath);
  }

  // ── Path B: standard Gmail attachment ────────────────────────────────────
  if (args.attachment_id) {
    const gmail = await getGmail();
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: args.message_id,
      id: args.attachment_id,
    });
    const data = att.data.data;
    if (!data) return makeTextContent("Attachment has no data.");
    const buf = Buffer.from(data, "base64url");
    fs.writeFileSync(destPath, buf);
    return makeTextContent(`Attachment saved: ${destPath}\nSize: ${(buf.length / 1024).toFixed(1)} KB`);
  }

  // ── Path C: no attachment_id — scan body for Drive links ─────────────────
  const gmail = await getGmail();
  const msg = await gmail.users.messages.get({ userId: "me", id: args.message_id, format: "full" });
  const body = extractBody(msg.data.payload);

  const drivePattern = /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = drivePattern.exec(body)) !== null) ids.push(m[1]);

  if (ids.length === 0) {
    return makeTextContent(
      `No attachment_id provided and no Google Drive links found in message ${args.message_id}.\n` +
      "Use gmail_get_email to inspect the message and pass attachment_id or drive_file_id."
    );
  }

  // Download first Drive link found
  return downloadFromDrive(ids[0], destPath, ids.length > 1 ? ids : undefined);
}

async function downloadFromDrive(
  fileId: string,
  destPath: string,
  allIds?: string[]
): Promise<CallToolResult> {
  const { google: goog } = await import("googleapis");
  const { getGoogleAuthClient } = await import("../auth/google.js");
  const auth = await getGoogleAuthClient();
  const drive = goog.drive({ version: "v3", auth });

  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    fs.writeFileSync(destPath, buf);
    const extra = allIds && allIds.length > 1
      ? `\nOther Drive IDs found in message: ${allIds.slice(1).join(", ")}`
      : "";
    return makeTextContent(
      `Drive file downloaded: ${destPath}\nFile ID: ${fileId}\nSize: ${(buf.length / 1024).toFixed(1)} KB${extra}`
    );
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code ?? "unknown";
    if (status === 403 || status === 404) {
      return makeTextContent(
        `Cannot download Drive file ${fileId} — access denied or file not found.\n` +
        `Status: ${status}\n` +
        `Open in browser: https://drive.google.com/file/d/${fileId}/view\n` +
        (allIds && allIds.length > 1 ? `Other IDs in message: ${allIds.slice(1).join(", ")}` : "")
      );
    }
    throw err;
  }
}

export async function gmailArchiveEmail(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: args.message_id,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
  return makeTextContent(`Email ${args.message_id} archived.`);
}
