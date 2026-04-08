import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getDocs() {
  const auth = await getGoogleAuthClient();
  return google.docs({ version: "v1", auth });
}

async function getDrive() {
  const auth = await getGoogleAuthClient();
  return google.drive({ version: "v3", auth });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function gdocsCreateDocument(args: {
  title: string;
  content?: string;
}): Promise<CallToolResult> {
  const docs = await getDocs();
  const res = await docs.documents.create({
    requestBody: { title: args.title },
  });

  const docId = res.data.documentId!;

  if (args.content) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text: args.content } }],
      },
    });
  }

  return ok(`Document created: ${res.data.title}\nID: ${docId}\nLink: https://docs.google.com/document/d/${docId}/edit`);
}

export async function gdocsGetDocument(args: {
  document_id: string;
}): Promise<CallToolResult> {
  const docs = await getDocs();
  const res = await docs.documents.get({ documentId: args.document_id });

  const title = res.data.title ?? "(untitled)";
  let text = "";

  for (const element of res.data.body?.content ?? []) {
    for (const pe of element.paragraph?.elements ?? []) {
      text += pe.textRun?.content ?? "";
    }
  }

  return ok(`Title: ${title}\nID: ${args.document_id}\n\n${text.trim()}`);
}

export async function gdocsFindDocument(args: {
  query: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const drive = await getDrive();
  const res = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.document' and fullText contains '${args.query.replace(/'/g, "\\'")}' and trashed=false`,
    pageSize: args.max_results ?? 10,
    fields: "files(id, name, modifiedTime, webViewLink)",
  });

  const files = res.data.files ?? [];
  if (files.length === 0) return ok("No documents found.");

  const lines = files.map(
    (f) => `ID: ${f.id}\nTitle: ${f.name}\nModified: ${f.modifiedTime}\nLink: ${f.webViewLink}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

export async function gdocsAppendText(args: {
  document_id: string;
  text: string;
}): Promise<CallToolResult> {
  const docs = await getDocs();
  const doc = await docs.documents.get({ documentId: args.document_id });

  const endIndex = doc.data.body?.content?.at(-1)?.endIndex ?? 1;

  await docs.documents.batchUpdate({
    documentId: args.document_id,
    requestBody: {
      requests: [{ insertText: { location: { index: endIndex - 1 }, text: "\n" + args.text } }],
    },
  });

  return ok(`Text appended to document ${args.document_id}.`);
}

export async function gdocsFindAndReplace(args: {
  document_id: string;
  find: string;
  replace: string;
}): Promise<CallToolResult> {
  const docs = await getDocs();
  await docs.documents.batchUpdate({
    documentId: args.document_id,
    requestBody: {
      requests: [{
        replaceAllText: {
          containsText: { text: args.find, matchCase: false },
          replaceText: args.replace,
        },
      }],
    },
  });
  return ok(`Replaced "${args.find}" with "${args.replace}" in document ${args.document_id}.`);
}
