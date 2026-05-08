import fs from "fs";
import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";

// pdf-parse ships as CommonJS and its index.js has a debug-mode side effect
// that tries to read a test fixture if the file isn't loaded the right way.
// Importing the inner module bypasses that and works reliably under ESM.
const require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number; info?: any; metadata?: any }>
  = require("pdf-parse/lib/pdf-parse.js");

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

type ExtractResult = {
  source: "text_layer" | "empty";
  text: string;
  num_pages: number;
  warnings: string[];
};

async function extractFromBuffer(buf: Buffer): Promise<ExtractResult> {
  const data = await pdfParse(buf);
  const text = (data.text || "").trim();
  const num_pages = data.numpages || 0;

  if (!text) {
    return {
      source: "empty",
      text: "",
      num_pages,
      warnings: [
        "No text layer found. PDF is likely a scanned image.",
        "OCR fallback (tesseract) not yet wired in this server — caller should download the PDF and OCR locally, or request OCR support be added.",
      ],
    };
  }

  return { source: "text_layer", text, num_pages, warnings: [] };
}

export async function extractPdfText(args: {
  file_path?: string;
  drive_file_id?: string;
  gmail_message_id?: string;
  attachment_id?: string;
  page_range?: string; // currently informational only — pdf-parse returns full doc text
}): Promise<CallToolResult> {
  let buf: Buffer | null = null;
  let label = "";

  try {
    if (args.file_path) {
      if (!fs.existsSync(args.file_path)) {
        return ok(`ERROR: file not found: ${args.file_path}`);
      }
      buf = fs.readFileSync(args.file_path);
      label = `file: ${args.file_path}`;
    } else if (args.drive_file_id) {
      const auth = await getGoogleAuthClient();
      const drive = google.drive({ version: "v3", auth });
      const res = await drive.files.get(
        { fileId: args.drive_file_id, alt: "media" },
        { responseType: "arraybuffer" }
      );
      buf = Buffer.from(res.data as ArrayBuffer);
      label = `drive_file_id: ${args.drive_file_id}`;
    } else if (args.gmail_message_id && args.attachment_id) {
      const auth = await getGoogleAuthClient();
      const gmail = google.gmail({ version: "v1", auth });
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: args.gmail_message_id,
        id: args.attachment_id,
      });
      if (!att.data.data) return ok("ERROR: gmail attachment has no data field");
      buf = Buffer.from(att.data.data, "base64url");
      label = `gmail msg ${args.gmail_message_id} attachment ${args.attachment_id}`;
    } else {
      return ok(
        "ERROR: pass exactly one of:\n" +
        "  - file_path (server-local path)\n" +
        "  - drive_file_id (Google Drive file ID)\n" +
        "  - gmail_message_id + attachment_id (Gmail attachment)"
      );
    }
  } catch (e: any) {
    return ok(`ERROR fetching PDF bytes: ${e?.message || e}`);
  }

  try {
    const result = await extractFromBuffer(buf!);
    const lines = [
      `Source:    ${result.source}`,
      `Pages:     ${result.num_pages}`,
      `From:      ${label}`,
      `Bytes:     ${buf!.length}`,
    ];
    if (args.page_range) {
      lines.push(`Note:      page_range "${args.page_range}" was passed but is ignored — full document returned (per-page extraction not yet supported).`);
    }
    lines.push("");
    lines.push("--- TEXT ---");
    lines.push(result.text || "(no text extracted)");
    if (result.warnings.length) {
      lines.push("");
      lines.push("--- WARNINGS ---");
      lines.push(...result.warnings.map(w => `- ${w}`));
    }
    return ok(lines.join("\n"));
  } catch (e: any) {
    return ok(`ERROR parsing PDF: ${e?.message || e}\nLikely an encrypted, malformed, or password-protected PDF.`);
  }
}

// One-call shortcut for the common "I have a Gmail message and want the text
// of one of its PDF attachments" pattern. Avoids forcing the caller to first
// list attachments to find the attachment_id.
export async function gmailAttachmentText(args: {
  message_id: string;
  attachment_filename: string;
}): Promise<CallToolResult> {
  let auth;
  try {
    auth = await getGoogleAuthClient();
  } catch (e: any) {
    return ok(`ERROR: Gmail auth failed: ${e?.message || e}`);
  }
  const gmail = google.gmail({ version: "v1", auth });

  let msg;
  try {
    msg = await gmail.users.messages.get({
      userId: "me",
      id: args.message_id,
      format: "full",
    });
  } catch (e: any) {
    return ok(`ERROR: could not fetch gmail message ${args.message_id}: ${e?.message || e}`);
  }

  // Walk the MIME tree to collect every attachment
  type Att = { filename: string; attachment_id: string; mime_type: string; size: number };
  const found: Att[] = [];
  function walk(p: any) {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      found.push({
        filename: p.filename,
        attachment_id: p.body.attachmentId,
        mime_type: p.mimeType || "application/octet-stream",
        size: Number(p.body?.size ?? 0),
      });
    }
    if (Array.isArray(p.parts)) for (const c of p.parts) walk(c);
  }
  walk((msg.data as any).payload);

  if (found.length === 0) {
    return ok(`No attachments found in message ${args.message_id}.`);
  }

  // Match strategy: exact filename first, then case-insensitive substring.
  // Substring lets the caller pass just "LossNotice" and match
  // "CLM_1226000099_LossNotice_415014795.pdf".
  const target = args.attachment_filename;
  let match = found.find(a => a.filename === target);
  if (!match) {
    const lower = target.toLowerCase();
    match = found.find(a => a.filename.toLowerCase().includes(lower));
  }
  if (!match) {
    return ok(
      `No attachment matching "${target}" in message ${args.message_id}.\n` +
      `Found ${found.length} attachment(s):\n` +
      found.map(a => `  - ${a.filename} (${a.mime_type}, ${(a.size / 1024).toFixed(1)} KB)`).join("\n")
    );
  }

  return extractPdfText({
    gmail_message_id: args.message_id,
    attachment_id: match.attachment_id,
  });
}
