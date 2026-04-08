import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Tool implementations
import { gmailSendEmail, gmailFindEmail, gmailGetEmail, gmailReplyToEmail, gmailArchiveEmail } from "./tools/gmail.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent, calendarListCalendars } from "./tools/calendar.js";
import { driveFindFile, driveGetFile, driveCreateFile, driveDeleteFile, driveMoveFile, driveCreateFolder } from "./tools/drive.js";
import { sheetsGetRows, sheetsAppendRow, sheetsUpdateRow, sheetsClearRange, sheetsLookupRow, sheetsCreateSpreadsheet } from "./tools/sheets.js";
import { imessageSend, imessageGetRecentChats } from "./tools/imessage.js";
import { httpRequest } from "./tools/http.js";

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // Gmail
  {
    name: "gmail_send_email",
    description: "Send an email via Gmail",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC email address (optional)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_find_email",
    description: "Search for emails using Gmail search syntax (e.g. 'from:alice subject:invoice')",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query" },
        max_results: { type: "number", description: "Max number of results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_get_email",
    description: "Get the full content of an email by message ID",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Gmail message ID" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_reply_to_email",
    description: "Reply to an existing email thread",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Gmail message ID to reply to" },
        body: { type: "string", description: "Reply body text" },
      },
      required: ["message_id", "body"],
    },
  },
  {
    name: "gmail_archive_email",
    description: "Archive (remove from inbox) an email by message ID",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Gmail message ID" },
      },
      required: ["message_id"],
    },
  },

  // Calendar
  {
    name: "calendar_list_events",
    description: "List calendar events within a time range",
    inputSchema: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
        time_min: { type: "string", description: "Start time in ISO 8601 format (default: now)" },
        time_max: { type: "string", description: "End time in ISO 8601 format" },
        query: { type: "string", description: "Free-text search query" },
        max_results: { type: "number", description: "Max events to return (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a new calendar event",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time in ISO 8601 format (e.g. 2026-04-10T14:00:00-05:00)" },
        end: { type: "string", description: "End time in ISO 8601 format" },
        description: { type: "string", description: "Event description" },
        location: { type: "string", description: "Event location" },
        attendees: { type: "array", items: { type: "string" }, description: "List of attendee email addresses" },
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "calendar_update_event",
    description: "Update an existing calendar event",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event ID" },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        calendar_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event ID to delete" },
        calendar_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "calendar_list_calendars",
    description: "List all calendars accessible to the authenticated user",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // Drive
  {
    name: "drive_find_file",
    description: "Search for files in Google Drive using Drive query syntax",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Drive query (e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\")" },
        max_results: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_get_file",
    description: "Get metadata for a specific file by ID",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Google Drive file ID" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "drive_create_file",
    description: "Create a new text file in Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name" },
        content: { type: "string", description: "File text content" },
        mime_type: { type: "string", description: "MIME type (default: text/plain)" },
        folder_id: { type: "string", description: "Parent folder ID (optional)" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "drive_delete_file",
    description: "Delete a file from Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "drive_move_file",
    description: "Move a file to a different folder in Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        new_folder_id: { type: "string" },
      },
      required: ["file_id", "new_folder_id"],
    },
  },
  {
    name: "drive_create_folder",
    description: "Create a folder in Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parent_id: { type: "string", description: "Parent folder ID (optional)" },
      },
      required: ["name"],
    },
  },

  // Sheets
  {
    name: "sheets_get_rows",
    description: "Read rows from a Google Sheets range (e.g. 'Sheet1!A1:D10')",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string", description: "A1 notation range (e.g. 'Sheet1!A:Z')" },
      },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "sheets_append_row",
    description: "Append a new row to a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        sheet_name: { type: "string", description: "Sheet tab name (default: Sheet1)" },
        values: { type: "array", items: { type: "string" }, description: "List of cell values for the row" },
      },
      required: ["spreadsheet_id", "values"],
    },
  },
  {
    name: "sheets_update_row",
    description: "Update cells in a specific range of a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string", description: "A1 notation range to update (e.g. 'Sheet1!A2:C2')" },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
  },
  {
    name: "sheets_clear_range",
    description: "Clear all values in a range of a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
      },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "sheets_lookup_row",
    description: "Find rows in a sheet where a column matches a value",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        sheet_name: { type: "string" },
        column_header: { type: "string", description: "Column header to search in" },
        search_value: { type: "string", description: "Value to search for" },
      },
      required: ["spreadsheet_id", "column_header", "search_value"],
    },
  },
  {
    name: "sheets_create_spreadsheet",
    description: "Create a new Google Sheets spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        sheet_name: { type: "string", description: "First sheet tab name (default: Sheet1)" },
      },
      required: ["title"],
    },
  },

  // iMessage
  {
    name: "imessage_send",
    description: "Send an iMessage or SMS via macOS Messages app (requires macOS with Messages logged in)",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Phone number (e.g. +12025551234) or Apple ID email" },
        message: { type: "string", description: "Message text to send" },
      },
      required: ["recipient", "message"],
    },
  },
  {
    name: "imessage_get_recent_chats",
    description: "List recent chats from macOS Messages app",
    inputSchema: {
      type: "object",
      properties: {
        max_results: { type: "number", description: "Max chats to return (default 10)" },
      },
      required: [],
    },
  },

  // HTTP
  {
    name: "http_request",
    description: "Make an HTTP request to any URL (useful for custom APIs and webhooks)",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: { type: "string", description: "HTTP method: GET, POST, PUT, PATCH, DELETE (default: GET)" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Request headers as key-value pairs",
        },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      },
      required: ["url"],
    },
  },
];

// ─── Tool Router ───────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    // Gmail
    case "gmail_send_email":
      return gmailSendEmail(args as Parameters<typeof gmailSendEmail>[0]);
    case "gmail_find_email":
      return gmailFindEmail(args as Parameters<typeof gmailFindEmail>[0]);
    case "gmail_get_email":
      return gmailGetEmail(args as Parameters<typeof gmailGetEmail>[0]);
    case "gmail_reply_to_email":
      return gmailReplyToEmail(args as Parameters<typeof gmailReplyToEmail>[0]);
    case "gmail_archive_email":
      return gmailArchiveEmail(args as Parameters<typeof gmailArchiveEmail>[0]);

    // Calendar
    case "calendar_list_events":
      return calendarListEvents(args as Parameters<typeof calendarListEvents>[0]);
    case "calendar_create_event":
      return calendarCreateEvent(args as Parameters<typeof calendarCreateEvent>[0]);
    case "calendar_update_event":
      return calendarUpdateEvent(args as Parameters<typeof calendarUpdateEvent>[0]);
    case "calendar_delete_event":
      return calendarDeleteEvent(args as Parameters<typeof calendarDeleteEvent>[0]);
    case "calendar_list_calendars":
      return calendarListCalendars();

    // Drive
    case "drive_find_file":
      return driveFindFile(args as Parameters<typeof driveFindFile>[0]);
    case "drive_get_file":
      return driveGetFile(args as Parameters<typeof driveGetFile>[0]);
    case "drive_create_file":
      return driveCreateFile(args as Parameters<typeof driveCreateFile>[0]);
    case "drive_delete_file":
      return driveDeleteFile(args as Parameters<typeof driveDeleteFile>[0]);
    case "drive_move_file":
      return driveMoveFile(args as Parameters<typeof driveMoveFile>[0]);
    case "drive_create_folder":
      return driveCreateFolder(args as Parameters<typeof driveCreateFolder>[0]);

    // Sheets
    case "sheets_get_rows":
      return sheetsGetRows(args as Parameters<typeof sheetsGetRows>[0]);
    case "sheets_append_row":
      return sheetsAppendRow(args as Parameters<typeof sheetsAppendRow>[0]);
    case "sheets_update_row":
      return sheetsUpdateRow(args as Parameters<typeof sheetsUpdateRow>[0]);
    case "sheets_clear_range":
      return sheetsClearRange(args as Parameters<typeof sheetsClearRange>[0]);
    case "sheets_lookup_row":
      return sheetsLookupRow(args as Parameters<typeof sheetsLookupRow>[0]);
    case "sheets_create_spreadsheet":
      return sheetsCreateSpreadsheet(args as Parameters<typeof sheetsCreateSpreadsheet>[0]);

    // iMessage
    case "imessage_send":
      return imessageSend(args as Parameters<typeof imessageSend>[0]);
    case "imessage_get_recent_chats":
      return imessageGetRecentChats(args as Parameters<typeof imessageGetRecentChats>[0]);

    // HTTP
    case "http_request":
      return httpRequest(args as Parameters<typeof httpRequest>[0]);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Server Setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-automation", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callTool(name, (args ?? {}) as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mcp-automation server running on stdio");
