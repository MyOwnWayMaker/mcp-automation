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

  const text = [
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Date: ${get("Date")}`,
    `Subject: ${get("Subject")}`,
    `Thread ID: ${res.data.threadId}`,
    `Message ID: ${res.data.id}`,
    "",
    body || "(no readable body found)",
  ].join("\n");

  return makeTextContent(text);
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
  attachment_id: string;
  dest_path: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const att = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: args.message_id,
    id: args.attachment_id,
  });

  const data = att.data.data;
  if (!data) return makeTextContent("Attachment has no data.");

  const buf = Buffer.from(data, "base64url");
  fs.mkdirSync(path.dirname(path.resolve(args.dest_path)), { recursive: true });
  fs.writeFileSync(args.dest_path, buf);

  return makeTextContent(
    `Attachment saved: ${args.dest_path}\nSize: ${(buf.length / 1024).toFixed(1)} KB`
  );
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
