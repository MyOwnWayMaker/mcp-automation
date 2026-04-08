import { google } from "googleapis";
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

  let body = "";
  const parts = res.data.payload?.parts ?? [];
  const textPart = parts.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) {
    body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
  } else if (res.data.payload?.body?.data) {
    body = Buffer.from(res.data.payload.body.data, "base64").toString("utf-8");
  }

  const text = [
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Date: ${get("Date")}`,
    `Subject: ${get("Subject")}`,
    `Thread ID: ${res.data.threadId}`,
    `Message ID: ${res.data.id}`,
    "",
    body || "(no plain-text body)",
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
