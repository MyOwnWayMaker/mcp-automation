import { google } from "googleapis";
import { Readable } from "stream";
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
  const res = await drive.files.list({
    q: args.query,
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
    fields: "parents",
  });

  const previousParents = (file.data.parents ?? []).join(",");

  const res = await drive.files.update({
    fileId: args.file_id,
    addParents: args.new_folder_id,
    removeParents: previousParents,
    fields: "id, name, parents",
  });

  return ok(`File ${res.data.name} moved to folder ${args.new_folder_id}.`);
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
