import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getSheets() {
  const auth = await getGoogleAuthClient();
  return google.sheets({ version: "v4", auth });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function sheetsGetRows(args: {
  spreadsheet_id: string;
  range: string;
}): Promise<CallToolResult> {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
  });

  const rows = res.data.values ?? [];
  if (rows.length === 0) return ok("No data found in that range.");

  const formatted = rows.map((row, i) => `Row ${i + 1}: ${row.join(" | ")}`);
  return ok(formatted.join("\n"));
}

export async function sheetsAppendRow(args: {
  spreadsheet_id: string;
  sheet_name?: string;
  values: string[];
}): Promise<CallToolResult> {
  const sheets = await getSheets();
  const range = args.sheet_name ?? "Sheet1";
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: args.spreadsheet_id,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [args.values] },
  });

  return ok(
    `Row appended.\nUpdated range: ${res.data.updates?.updatedRange}\nRows affected: ${res.data.updates?.updatedRows}`
  );
}

export async function sheetsUpdateRow(args: {
  spreadsheet_id: string;
  range: string;
  values: string[];
}): Promise<CallToolResult> {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [args.values] },
  });

  return ok(
    `Row updated.\nRange: ${res.data.updatedRange}\nCells updated: ${res.data.updatedCells}`
  );
}

export async function sheetsClearRange(args: {
  spreadsheet_id: string;
  range: string;
}): Promise<CallToolResult> {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
  });
  return ok(`Range ${args.range} cleared.`);
}

export async function sheetsLookupRow(args: {
  spreadsheet_id: string;
  sheet_name?: string;
  column_header: string;
  search_value: string;
}): Promise<CallToolResult> {
  const sheets = await getSheets();
  const range = args.sheet_name ?? "Sheet1";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: args.spreadsheet_id,
    range,
  });

  const rows = res.data.values ?? [];
  if (rows.length === 0) return ok("Sheet is empty.");

  const headers = rows[0];
  const colIndex = headers.findIndex(
    (h) => h.toLowerCase() === args.column_header.toLowerCase()
  );
  if (colIndex === -1) {
    return ok(`Column "${args.column_header}" not found. Headers: ${headers.join(", ")}`);
  }

  const matching = rows
    .slice(1)
    .filter((row) => row[colIndex] === args.search_value)
    .map((row) => {
      const obj = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
      return JSON.stringify(obj, null, 2);
    });

  if (matching.length === 0) {
    return ok(`No rows found where ${args.column_header} = "${args.search_value}"`);
  }

  return ok(matching.join("\n\n---\n\n"));
}

export async function sheetsCreateSpreadsheet(args: {
  title: string;
  sheet_name?: string;
}): Promise<CallToolResult> {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: args.title },
      sheets: [{ properties: { title: args.sheet_name ?? "Sheet1" } }],
    },
  });

  return ok(
    `Spreadsheet created: ${res.data.properties?.title}\nID: ${res.data.spreadsheetId}\nLink: ${res.data.spreadsheetUrl}`
  );
}
