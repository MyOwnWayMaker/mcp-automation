import { google } from "googleapis";
import { Readable } from "stream";
import fs from "fs";
import path from "path";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getDrive() {
  const auth = await getGoogleAuthClient();
  return google.drive({ version: "v3", auth });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function driveFindFile(args: {
  query: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const drive = await getDrive();

  // If the query looks like plain text (no Drive query operators), convert it
  const isDriveQuery = /\b(contains|=|!=|in|has|trashed|mimeType|parents|name|fullText)\b/.test(args.query);
  const q = isDriveQuery
    ? args.query
    : `(name contains '${args.query.replace(/'/g, "\\'")}' or fullText contains '${args.query.replace(/'/g, "\\'")}') and trashed = false`;

  const res = await drive.files.list({
    q,
    pageSize: args.max_results ?? 10,
    fields: "files(id, name, mimeType, size, modifiedTime, webViewLink)",
  });

  const files = res.data.files ?? [];
  if (files.length === 0) return ok("No files found.");

  const lines = files.map(
    (f) =>
      `ID: ${f.id}\nName: ${f.name}\nType: ${f.mimeType}\nModified: ${f.modifiedTime}\nLink: ${f.webViewLink ?? "N/A"}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

export async function driveGetFile(args: {
  file_id: string;
}): Promise<CallToolResult> {
  const drive = await getDrive();
  const meta = await drive.files.get({
    fileId: args.file_id,
    fields: "id, name, mimeType, size, modifiedTime, webViewLink, description",
  });

  const f = meta.data;
  const text = [
    `ID: ${f.id}`,
    `Name: ${f.name}`,
    `Type: ${f.mimeType}`,
    `Size: ${f.size ? `${(Number(f.size) / 1024).toFixed(1)} KB` : "N/A"}`,
    `Modified: ${f.modifiedTime}`,
    `Link: ${f.webViewLink ?? "N/A"}`,
    f.description ? `Description: ${f.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return ok(text);
}

export async function driveCreateFile(args: {
  name: string;
  content: string;
  mime_type?: string;
  folder_id?: string;
}): Promise<CallToolResult> {
  const drive = await getDrive();
  const mimeType = args.mime_type ?? "text/plain";

  const res = await drive.files.create({
    requestBody: {
      name: args.name,
      mimeType,
      parents: args.folder_id ? [args.folder_id] : undefined,
    },
    media: {
      mimeType,
      body: Readable.from([args.content]),
    },
    fields: "id, name, webViewLink",
  });

  return ok(`File created: ${res.data.name}\nID: ${res.data.id}\nLink: ${res.data.webViewLink}`);
}

export async function driveDeleteFile(args: {
  file_id: string;
}): Promise<CallToolResult> {
  const drive = await getDrive();
  await drive.files.delete({ fileId: args.file_id });
  return ok(`File ${args.file_id} deleted.`);
}

export async function driveMoveFile(args: {
  file_id: string;
  new_folder_id: string;
}): Promise<CallToolResult> {
  const drive = await getDrive();

  const file = await drive.files.get({
    fileId: args.file_id,
    fields: "id, name, parents",
    supportsAllDrives: true,
  });

  const parents = file.data.parents ?? [];
  const parentsDiag = `parents=${JSON.stringify(parents)}`;

  if (parents.includes(args.new_folder_id)) {
    return ok(`File "${file.data.name}" is already in folder ${args.new_folder_id} — no move needed.\n[diag: ${parentsDiag}]`);
  }

  const removeParents = parents.length > 0 ? parents.join(",") : "root";

  try {
    const res = await drive.files.update({
      fileId: args.file_id,
      addParents: args.new_folder_id,
      removeParents,
      fields: "id, name, parents",
      supportsAllDrives: true,
    });

    return ok(
      `File "${res.data.name}" moved to folder ${args.new_folder_id}.\n` +
      `[diag: ${parentsDiag} → new parents=${JSON.stringify(res.data.parents)}]`
    );
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? String(err);
    return ok(
      `❌ Drive move failed: ${msg}\n` +
      `[diag: file="${file.data.name}" | ${parentsDiag} | removeParents="${removeParents}" | addParents="${args.new_folder_id}"]`
    );
  }
}

// Extension → MIME type map shared by both upload paths
const MIME_MAP: Record<string, string> = {
  ".pdf":  "application/pdf",
  ".mp4":  "video/mp4",
  ".mov":  "video/quicktime",
  ".zip":  "application/zip",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".csv":  "text/csv",
  ".txt":  "text/plain",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function driveUploadFile(args: {
  file_bytes_b64?: string;   // base64-encoded file content — works from any caller regardless of where the server runs
  local_path?: string;       // deprecated: only works when the MCP server has access to the same filesystem (not Railway)
  folder_id?: string;
  name?: string;
  mime_type?: string;
}): Promise<CallToolResult> {
  const drive = await getDrive();

  let body: NodeJS.ReadableStream;
  let fileName: string;

  if (args.file_bytes_b64) {
    const buf = Buffer.from(args.file_bytes_b64, "base64");
    body = Readable.from(buf);
    fileName = args.name ?? "upload";
  } else if (args.local_path) {
    if (!fs.existsSync(args.local_path)) {
      return ok(
        `File not found at path: ${args.local_path}\n` +
        `Note: the MCP server runs on Railway and cannot access your local Mac filesystem. ` +
        `Read the file locally, base64-encode it, and pass the result as file_bytes_b64 instead.`
      );
    }
    body = fs.createReadStream(args.local_path);
    fileName = args.name ?? path.basename(args.local_path);
  } else {
    return ok("Either file_bytes_b64 or local_path must be provided.");
  }

  const ext = path.extname(fileName).toLowerCase();
  const mimeType = args.mime_type ?? MIME_MAP[ext] ?? "application/octet-stream";

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType,
      parents: args.folder_id ? [args.folder_id] : undefined,
    },
    media: { mimeType, body },
    fields: "id, name, webViewLink, size",
  });

  const sizeKb = res.data.size ? `${(Number(res.data.size) / 1024).toFixed(1)} KB` : "unknown size";
  return ok(`File uploaded: ${res.data.name}\nID: ${res.data.id}\nSize: ${sizeKb}\nLink: ${res.data.webViewLink}`);
}

export async function driveCreateFolder(args: {
  name: string;
  parent_id?: string;
}): Promise<CallToolResult> {
  const drive = await getDrive();
  const res = await drive.files.create({
    requestBody: {
      name: args.name,
      mimeType: "application/vnd.google-apps.folder",
      parents: args.parent_id ? [args.parent_id] : undefined,
    },
    fields: "id, name, webViewLink",
  });
  return ok(`Folder created: ${res.data.name}\nID: ${res.data.id}\nLink: ${res.data.webViewLink}`);
}
