import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Suppress dotenvx's stdout output — it breaks MCP stdio JSON transport
const _write = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
dotenv.config({ path: resolve(__dirname, "../.env") });
process.stdout.write = _write;
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

// Tool implementations
import { gmailSendEmail, gmailFindEmail, gmailGetEmail, gmailReplyToEmail, gmailArchiveEmail, gmailDownloadAttachment } from "./tools/gmail.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent, calendarListCalendars } from "./tools/calendar.js";
import { driveFindFile, driveGetFile, driveCreateFile, driveDeleteFile, driveMoveFile, driveCreateFolder, driveUploadFile } from "./tools/drive.js";
import { sheetsGetRows, sheetsAppendRow, sheetsUpdateRow, sheetsClearRange, sheetsLookupRow, sheetsCreateSpreadsheet } from "./tools/sheets.js";
import { imessageSend, imessageGetRecentChats } from "./tools/imessage.js";
import { httpRequest } from "./tools/http.js";
import { gdocsCreateDocument, gdocsGetDocument, gdocsFindDocument, gdocsAppendText, gdocsFindAndReplace } from "./tools/gdocs.js";
import { tasksListTasklists, tasksListTasks, tasksCreateTask, tasksUpdateTask, tasksCompleteTask, tasksDeleteTask } from "./tools/tasks.js";
import { meetScheduleMeeting, meetGetMeeting, meetCancelMeeting } from "./tools/meet.js";
import { notionListDatabases, notionFindPage, notionGetPage, notionCreatePage, notionAppendToPage, notionQueryDatabase, notionCreateDatabaseItem, notionUpdateDatabaseItem, notionUpdateDatabaseSchema, notionAddDatabaseProperty, notionUpdateBlock, notionInitializeItemSubtasks, notionSetupClaimsSubtasks, notionUpdateSubtask, notionGetSubtaskStatus, notionListPageBlocks, notionArchiveBlock, notionInsertAfterBlock, notionAppendMultiBlock } from "./tools/notion.js";
import { hubspotFindContact, hubspotCreateContact, hubspotUpdateContact, hubspotCreateDeal, hubspotFindDeal, hubspotUpdateDeal, hubspotCreateCompany, hubspotFindCompany, hubspotCreateNote } from "./tools/hubspot.js";
import { geminiSendPrompt, geminiChat, geminiAnalyzeText } from "./tools/gemini.js";
import { notaryGetNewEmails, notarySendEmail, notaryMarkEmailRead, notaryCheckAvailability, notaryGetTravelTime, gmailNotaryFindEmail, gmailNotaryGetEmail, gmailNotaryReplyToEmail, gmailNotaryArchiveEmail } from "./tools/notary.js";
import { notarygadgetCreateSigning, notarygadgetUpdateSigning, notarygadgetCompleteSigning, notarygadgetEnterMileage, notarygadgetRecordPayment, notarygadgetGetSignings, notarygadgetSendInvoice, notarygadgetDeleteSigning } from "./tools/notarygadget.js";
import { filetracListCompanies, filetracListClaims, filetracGetClaim, filetracUpdateClaimDates, filetracAddNote, filetracSubmitTimeExpense, filetracGetNotes, filetracBulkGetClaims, filetracBulkAddNote, filetracListDocuments, filetracDownloadReport, filetracRefreshSession, filetracDumpHtml } from "./tools/filetrac.js";
import { agentRollUpLogs } from "./tools/local.js";
import { xactListAssignments, xactGetAssignment, xactUpdateDates, xactUpdateWorkflowStatus, xactAddNote, xactGetNotes, xactFindAssignmentByClaim, xactFindAssignmentByName } from "./tools/xactanalysis.js";
import { qbFindCustomer, qbCreateCustomer, qbUpdateCustomer, qbFindVendor, qbCreateVendor, qbFindInvoice, qbCreateInvoice, qbSendInvoice, qbVoidInvoice, qbUpdateInvoice, qbCreateExpense, qbFindExpenses, qbCreatePayment, qbFindPayments, qbProfitAndLoss, qbCashFlow, qbBalanceSheet } from "./tools/quickbooks.js";

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // Gmail
  { name: "gmail_send_email", description: "Send an email via Gmail", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "gmail_find_email", description: "Search for emails using Gmail search syntax", inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] } },
  { name: "gmail_get_email", description: "Get full content of an email by message ID", inputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] } },
  { name: "gmail_reply_to_email", description: "Reply to an existing email thread", inputSchema: { type: "object", properties: { message_id: { type: "string" }, body: { type: "string" } }, required: ["message_id", "body"] } },
  { name: "gmail_archive_email", description: "Archive an email by message ID", inputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] } },
  { name: "gmail_download_attachment", description: "Download a Gmail attachment OR a Google Drive file linked in an email body. Three modes: (1) pass attachment_id for standard Gmail attachments; (2) pass drive_file_id to download directly from Drive; (3) pass neither and the tool auto-detects Drive links in the message body. Returns structured error with the Drive URL if access is denied.", inputSchema: { type: "object", properties: { message_id: { type: "string" }, attachment_id: { type: "string", description: "Gmail attachment ID (from part.body.attachmentId in gmail_get_email)" }, drive_file_id: { type: "string", description: "Google Drive file ID — use when the email has a Drive share link instead of a true attachment" }, dest_path: { type: "string", description: "Absolute local path to save the file (e.g. /tmp/invoice.pdf)" } }, required: ["message_id", "dest_path"] } },

  // Calendar
  { name: "calendar_list_events", description: "List calendar events within a time range", inputSchema: { type: "object", properties: { calendar_id: { type: "string" }, time_min: { type: "string" }, time_max: { type: "string" }, query: { type: "string" }, max_results: { type: "number" } }, required: [] } },
  { name: "calendar_create_event", description: "Create a new calendar event. color_id values: 1=Lavender, 2=Sage(Green), 3=Grape(Purple), 4=Flamingo, 5=Banana(Yellow), 6=Tangerine, 7=Peacock(Teal), 8=Graphite, 9=Blueberry(Blue), 10=Basil, 11=Tomato(Red)", inputSchema: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, calendar_id: { type: "string" }, color_id: { type: "number", description: "Google Calendar color ID 1-11" }, reminders: { type: "array", description: "Custom reminders. Each entry: { method: 'popup'|'email', minutes: number } or { method: 'popup'|'email', hours: number }", items: { type: "object", properties: { method: { type: "string", enum: ["popup", "email", "sms"] }, minutes: { type: "number" }, hours: { type: "number" } }, required: ["method"] } } }, required: ["title", "start", "end"] } },
  { name: "calendar_update_event", description: "Update an existing calendar event. color_id values: 1=Lavender, 2=Sage(Green), 3=Grape(Purple), 4=Flamingo, 5=Banana(Yellow), 6=Tangerine, 7=Peacock(Teal), 8=Graphite, 9=Blueberry(Blue), 10=Basil, 11=Tomato(Red)", inputSchema: { type: "object", properties: { event_id: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, calendar_id: { type: "string" }, color_id: { type: "number", description: "Google Calendar color ID 1-11" }, reminders: { type: "array", description: "Custom reminders. Each entry: { method: 'popup'|'email', minutes: number } or { method: 'popup'|'email', hours: number }", items: { type: "object", properties: { method: { type: "string", enum: ["popup", "email", "sms"] }, minutes: { type: "number" }, hours: { type: "number" } }, required: ["method"] } } }, required: ["event_id"] } },
  { name: "calendar_delete_event", description: "Delete a calendar event", inputSchema: { type: "object", properties: { event_id: { type: "string" }, calendar_id: { type: "string" } }, required: ["event_id"] } },
  { name: "calendar_list_calendars", description: "List all accessible calendars", inputSchema: { type: "object", properties: {}, required: [] } },

  // Drive
  { name: "drive_find_file", description: "Search for files in Google Drive", inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] } },
  { name: "drive_get_file", description: "Get metadata for a file by ID", inputSchema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "drive_create_file", description: "Create a new text file in Google Drive", inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, mime_type: { type: "string" }, folder_id: { type: "string" } }, required: ["name", "content"] } },
  { name: "drive_delete_file", description: "Delete a file from Google Drive", inputSchema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "drive_move_file", description: "Move a file to a different folder. Fetches current parents first, then calls files.update with addParents+removeParents so Drive sees it as a true move. Works for files at root or in a subfolder. Returns no-op if file is already in the target folder.", inputSchema: { type: "object", properties: { file_id: { type: "string" }, new_folder_id: { type: "string" } }, required: ["file_id", "new_folder_id"] } },
  { name: "drive_create_folder", description: "Create a folder in Google Drive", inputSchema: { type: "object", properties: { name: { type: "string" }, parent_id: { type: "string" } }, required: ["name"] } },
  { name: "drive_upload_file", description: "Upload a file to Google Drive. PREFERRED: pass file_bytes_b64 (base64-encoded file content) + name — works from any caller including when the MCP server runs on Railway (remote host). DEPRECATED: local_path only works when the server has access to the same filesystem as the caller.", inputSchema: { type: "object", properties: { file_bytes_b64: { type: "string", description: "Base64-encoded file content (preferred — works regardless of where the server runs)" }, local_path: { type: "string", description: "Deprecated: absolute path on the server's local filesystem (does NOT work on Railway)" }, folder_id: { type: "string", description: "Drive folder ID to upload into (optional)" }, name: { type: "string", description: "Filename on Drive — required when using file_bytes_b64, defaults to basename when using local_path" }, mime_type: { type: "string", description: "Override MIME type (optional, auto-detected from file extension)" } }, required: [] } },

  // Sheets
  { name: "sheets_get_rows", description: "Read rows from a Google Sheets range", inputSchema: { type: "object", properties: { spreadsheet_id: { type: "string" }, range: { type: "string" } }, required: ["spreadsheet_id", "range"] } },
  { name: "sheets_append_row", description: "Append a new row to a Google Sheet", inputSchema: { type: "object", properties: { spreadsheet_id: { type: "string" }, sheet_name: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["spreadsheet_id", "values"] } },
  { name: "sheets_update_row", description: "Update cells in a specific range", inputSchema: { type: "object", properties: { spreadsheet_id: { type: "string" }, range: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["spreadsheet_id", "range", "values"] } },
  { name: "sheets_clear_range", description: "Clear all values in a range", inputSchema: { type: "object", properties: { spreadsheet_id: { type: "string" }, range: { type: "string" } }, required: ["spreadsheet_id", "range"] } },
  { name: "sheets_lookup_row", description: "Find rows where a column matches a value", inputSchema: { type: "object", properties: { spreadsheet_id: { type: "string" }, sheet_name: { type: "string" }, column_header: { type: "string" }, search_value: { type: "string" } }, required: ["spreadsheet_id", "column_header", "search_value"] } },
  { name: "sheets_create_spreadsheet", description: "Create a new Google Sheets spreadsheet", inputSchema: { type: "object", properties: { title: { type: "string" }, sheet_name: { type: "string" } }, required: ["title"] } },

  // Google Docs
  { name: "gdocs_create_document", description: "Create a new Google Docs document", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title"] } },
  { name: "gdocs_get_document", description: "Get the content of a Google Doc by ID", inputSchema: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"] } },
  { name: "gdocs_find_document", description: "Search for Google Docs documents", inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] } },
  { name: "gdocs_append_text", description: "Append text to the end of a Google Doc", inputSchema: { type: "object", properties: { document_id: { type: "string" }, text: { type: "string" } }, required: ["document_id", "text"] } },
  { name: "gdocs_find_and_replace", description: "Find and replace text in a Google Doc", inputSchema: { type: "object", properties: { document_id: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["document_id", "find", "replace"] } },

  // Google Tasks
  { name: "tasks_list_tasklists", description: "List all Google Task lists", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "tasks_list_tasks", description: "List tasks in a task list", inputSchema: { type: "object", properties: { tasklist_id: { type: "string" }, show_completed: { type: "boolean" } }, required: [] } },
  { name: "tasks_create_task", description: "Create a new Google Task", inputSchema: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" }, due: { type: "string", description: "Due date in RFC 3339 format" }, tasklist_id: { type: "string" } }, required: ["title"] } },
  { name: "tasks_update_task", description: "Update an existing Google Task", inputSchema: { type: "object", properties: { task_id: { type: "string" }, title: { type: "string" }, notes: { type: "string" }, due: { type: "string" }, status: { type: "string", enum: ["needsAction", "completed"] }, tasklist_id: { type: "string" } }, required: ["task_id"] } },
  { name: "tasks_complete_task", description: "Mark a Google Task as completed", inputSchema: { type: "object", properties: { task_id: { type: "string" }, tasklist_id: { type: "string" } }, required: ["task_id"] } },
  { name: "tasks_delete_task", description: "Delete a Google Task", inputSchema: { type: "object", properties: { task_id: { type: "string" }, tasklist_id: { type: "string" } }, required: ["task_id"] } },

  // Google Meet
  { name: "meet_schedule_meeting", description: "Schedule a Google Meet meeting via Google Calendar", inputSchema: { type: "object", properties: { title: { type: "string" }, start: { type: "string", description: "ISO 8601 datetime" }, end: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, description: { type: "string" }, calendar_id: { type: "string" } }, required: ["title", "start", "end"] } },
  { name: "meet_get_meeting", description: "Get details and Meet link for a scheduled meeting", inputSchema: { type: "object", properties: { event_id: { type: "string" }, calendar_id: { type: "string" } }, required: ["event_id"] } },
  { name: "meet_cancel_meeting", description: "Cancel a Google Meet meeting", inputSchema: { type: "object", properties: { event_id: { type: "string" }, calendar_id: { type: "string" } }, required: ["event_id"] } },

  // Notion
  { name: "notion_list_databases", description: "List ALL databases (grids/tables) in the Notion workspace with their IDs and titles. Use this first to discover database IDs before querying them.", inputSchema: { type: "object", properties: {} } },
  { name: "notion_find_page", description: "Search for pages and databases in Notion by keyword. Returns both pages and databases by default.", inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" }, type: { type: "string", enum: ["page", "database", "all"] } }, required: ["query"] } },
  { name: "notion_get_page", description: "Get the content of a Notion page by ID", inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] } },
  { name: "notion_create_page", description: "Create a new Notion page", inputSchema: { type: "object", properties: { title: { type: "string" }, parent_page_id: { type: "string" }, parent_database_id: { type: "string" }, content: { type: "string" } }, required: ["title"] } },
  { name: "notion_append_to_page", description: "Append content to a Notion page. Use block_type='to_do' to add a checkable subtask item (for custom/ad-hoc subtasks on a specific claim).", inputSchema: { type: "object", properties: { page_id: { type: "string" }, content: { type: "string" }, block_type: { type: "string", enum: ["paragraph", "to_do", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item"] } }, required: ["page_id", "content"] } },
  { name: "notion_query_database", description: "Query items in a Notion database", inputSchema: { type: "object", properties: { database_id: { type: "string" }, max_results: { type: "number" } }, required: ["database_id"] } },
  { name: "notion_create_database_item", description: "Create a new item in a Notion database. Set init_subtasks=true when creating a claim to automatically initialize all 5 subtask statuses to 'Not Started'.", inputSchema: { type: "object", properties: { database_id: { type: "string" }, title: { type: "string" }, properties: { type: "object", additionalProperties: { type: "string" } }, init_subtasks: { type: "boolean", description: "If true, sets Inspection/Photo Report/Sketch/Estimate/Narrative Status to 'Not Started' on the new item" } }, required: ["database_id", "title"] } },
  { name: "notion_update_database_item", description: "Update properties on an existing Notion database item (page). Pass properties as a map of property name → {type, value}. Supported types: select, multi_select, title, rich_text, text, date, number, checkbox, url, email, phone_number, status.", inputSchema: { type: "object", properties: { page_id: { type: "string" }, properties: { type: "object", additionalProperties: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["type"] } } }, required: ["page_id", "properties"] } },
  { name: "notion_update_database_schema", description: "Update the select/multi_select options (names and colors) on a Notion database property. Valid colors: default, gray, brown, orange, yellow, green, blue, purple, pink, red.", inputSchema: { type: "object", properties: { database_id: { type: "string" }, property_name: { type: "string" }, select_options: { type: "array", items: { type: "object", properties: { name: { type: "string" }, color: { type: "string" } }, required: ["name"] } } }, required: ["database_id", "property_name", "select_options"] } },
  { name: "notion_add_database_property", description: "Add a new property (column) to a Notion database. Supports: number, text, checkbox, date, url, email, phone_number, select, multi_select. For number columns, optionally specify number_format (e.g. 'number', 'dollar', 'percent').", inputSchema: { type: "object", properties: { database_id: { type: "string" }, property_name: { type: "string" }, property_type: { type: "string", enum: ["number", "text", "checkbox", "date", "url", "email", "phone_number", "select", "multi_select"] }, number_format: { type: "string", description: "Only for number type. Options: number, number_with_commas, percent, dollar, euro, pound, yen, etc." } }, required: ["database_id", "property_name", "property_type"] } },
  { name: "notion_update_block", description: "Edit the text content of an existing Notion block (heading, paragraph, list item, etc.) by block ID. Retrieve block IDs using notion_get_page.", inputSchema: { type: "object", properties: { block_id: { type: "string" }, content: { type: "string" }, block_type: { type: "string", enum: ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout"] } }, required: ["block_id", "content"] } },
  { name: "notion_initialize_item_subtasks", description: "Retroactively activate subtask tracking on an existing claim item. Sets all 5 subtask statuses (Inspection, Photo Report, Sketch, Estimate, Narrative) to 'Not Started'. Use on any My Claims item that was created before subtask support.", inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] } },
  { name: "notion_setup_claims_subtasks", description: "One-time setup: adds Inspection, Photo Report, Sketch, Estimate, Narrative subtask property groups to a claim database. Each gets checkbox + Status + Start + Hours. Safe to re-run.", inputSchema: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"] } },
  { name: "notion_update_subtask", description: "Start, pause, or complete a subtask on a claim item. Automatically tracks time — pause accumulates elapsed hours, resume starts a new session. action: start | pause | complete. subtask: Inspection | Photo Report | Sketch | Estimate | Narrative", inputSchema: { type: "object", properties: { page_id: { type: "string" }, subtask: { type: "string" }, action: { type: "string", enum: ["start", "pause", "complete"] } }, required: ["page_id", "subtask", "action"] } },
  { name: "notion_get_subtask_status", description: "Get all subtask statuses and accumulated hours for a claim item.", inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] } },
  { name: "notion_list_page_blocks", description: "List all blocks on a Notion page with their IDs, types, and text. Use this to find block IDs before calling notion_archive_block, notion_insert_after_block, or notion_update_block.", inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] } },
  { name: "notion_archive_block", description: "Archive (soft-delete) a Notion block by ID. Recoverable from Notion trash for 30 days. Use notion_list_page_blocks to find block IDs.", inputSchema: { type: "object", properties: { block_id: { type: "string" } }, required: ["block_id"] } },
  { name: "notion_insert_after_block", description: "Insert a new block immediately after a given block ID. Use notion_list_page_blocks to find the target block ID. Supports paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item, to_do, quote, callout.", inputSchema: { type: "object", properties: { target_block_id: { type: "string", description: "Block ID to insert after" }, content: { type: "string" }, block_type: { type: "string", enum: ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout"] } }, required: ["target_block_id", "content"] } },
  { name: "notion_append_multi_block", description: "Append multiple blocks to a Notion page in a single API call. Preserves headings, bullets, code blocks, and dividers. Pass an array of {content, block_type} objects. Much faster than calling notion_append_to_page repeatedly.", inputSchema: { type: "object", properties: { page_id: { type: "string" }, blocks: { type: "array", items: { type: "object", properties: { content: { type: "string" }, block_type: { type: "string", description: "paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, to_do, quote, callout, divider" } }, required: ["content"] } } }, required: ["page_id", "blocks"] } },

  // HubSpot
  { name: "hubspot_find_contact", description: "Find a HubSpot contact by email", inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } },
  { name: "hubspot_create_contact", description: "Create a new HubSpot contact", inputSchema: { type: "object", properties: { email: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }, required: ["email"] } },
  { name: "hubspot_update_contact", description: "Update a HubSpot contact", inputSchema: { type: "object", properties: { contact_id: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, phone: { type: "string" }, company: { type: "string" }, email: { type: "string" } }, required: ["contact_id"] } },
  { name: "hubspot_create_deal", description: "Create a new HubSpot deal", inputSchema: { type: "object", properties: { name: { type: "string" }, stage: { type: "string" }, amount: { type: "string" }, close_date: { type: "string" } }, required: ["name", "stage"] } },
  { name: "hubspot_find_deal", description: "Find a HubSpot deal by name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "hubspot_update_deal", description: "Update a HubSpot deal", inputSchema: { type: "object", properties: { deal_id: { type: "string" }, name: { type: "string" }, stage: { type: "string" }, amount: { type: "string" }, close_date: { type: "string" } }, required: ["deal_id"] } },
  { name: "hubspot_create_company", description: "Create a new HubSpot company", inputSchema: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" }, industry: { type: "string" } }, required: ["name"] } },
  { name: "hubspot_find_company", description: "Find a HubSpot company by name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "hubspot_create_note", description: "Create a note in HubSpot, optionally linked to a contact or deal", inputSchema: { type: "object", properties: { body: { type: "string" }, contact_id: { type: "string" }, deal_id: { type: "string" } }, required: ["body"] } },

  // Gemini
  { name: "gemini_send_prompt", description: "Send a prompt to Google Gemini and get a response", inputSchema: { type: "object", properties: { prompt: { type: "string" }, model: { type: "string", description: "Model to use (default: gemini-2.0-flash)" }, system_instruction: { type: "string" } }, required: ["prompt"] } },
  { name: "gemini_chat", description: "Have a multi-turn conversation with Google Gemini", inputSchema: { type: "object", properties: { messages: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: ["user", "model"] }, content: { type: "string" } }, required: ["role", "content"] } }, model: { type: "string" }, system_instruction: { type: "string" } }, required: ["messages"] } },
  { name: "gemini_analyze_text", description: "Ask Gemini to analyze or transform a piece of text", inputSchema: { type: "object", properties: { text: { type: "string" }, task: { type: "string", description: "What to do with the text (e.g. 'summarize', 'translate to Spanish', 'extract action items')" }, model: { type: "string" } }, required: ["text", "task"] } },

  // Notary Email & Availability
  { name: "notary_get_new_emails", description: "Check drupenterprise1@gmail.com for new notary assignment emails", inputSchema: { type: "object", properties: { max_results: { type: "number" }, include_read: { type: "boolean" } }, required: [] } },
  { name: "notary_send_email", description: "Send an email from drupenterprise1@gmail.com", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, reply_to_message_id: { type: "string" }, thread_id: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "notary_mark_email_read", description: "Mark a notary email as read after processing", inputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] } },
  { name: "gmail_notary_find_email", description: "Search drupenterprise1@gmail.com using Gmail search syntax", inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] } },
  { name: "gmail_notary_get_email", description: "Get full content of an email from drupenterprise1@gmail.com by message ID", inputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] } },
  { name: "gmail_notary_reply_to_email", description: "Reply to an email thread from drupenterprise1@gmail.com", inputSchema: { type: "object", properties: { message_id: { type: "string" }, body: { type: "string" } }, required: ["message_id", "body"] } },
  { name: "gmail_notary_archive_email", description: "Archive an email from drupenterprise1@gmail.com inbox", inputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] } },
  { name: "notary_check_availability", description: "Check calendar availability and calculate travel time for a signing request", inputSchema: { type: "object", properties: { requested_date: { type: "string", description: "YYYY-MM-DD" }, requested_time: { type: "string", description: "HH:MM AM/PM" }, signing_address: { type: "string" }, estimated_duration_minutes: { type: "number" } }, required: ["requested_date", "requested_time", "signing_address"] } },
  { name: "notary_get_travel_time", description: "Calculate driving time between two addresses", inputSchema: { type: "object", properties: { origin: { type: "string" }, destination: { type: "string" } }, required: ["origin", "destination"] } },

  // XactAnalysis
  { name: "xact_list_assignments", description: "List XactAnalysis assignments. Defaults to up to 200 results over a 2-year window. Use include_all=true to see all assignments regardless of date, or since_date (YYYY-MM-DD) to filter from a specific date. Paginates automatically.", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["in_progress", "returned", "all"] }, max_results: { type: "number", description: "Max results to return (default 200, max 200)" }, since_date: { type: "string", description: "YYYY-MM-DD — only show assignments received on or after this date" }, include_all: { type: "boolean", description: "Remove date restriction entirely and return all assignments" } }, required: [] } },
  { name: "xact_find_assignment_by_claim", description: "Find a XactAnalysis assignment by carrier claim number using the top search bar (searches all years, not just the recent list). Returns MFN + detail. Example: '12-1226000034'.", inputSchema: { type: "object", properties: { claim_number: { type: "string", description: "Carrier claim number (exact match recommended)" } }, required: ["claim_number"] } },
  { name: "xact_find_assignment_by_name", description: "Find XactAnalysis assignments by policyholder name using the top Quick Search bar (searches all years). Returns a list of candidates with claim # and MFN. Use when you have the insured's name but not the claim number.", inputSchema: { type: "object", properties: { name_query: { type: "string", description: "Policyholder name or partial name to search" } }, required: ["name_query"] } },
  { name: "xact_get_assignment", description: "Get full detail for a XactAnalysis assignment by MFN code", inputSchema: { type: "object", properties: { mfn: { type: "string", description: "MFN code from the assignment URL (e.g. 06SSNJ3)" } }, required: ["mfn"] } },
  { name: "xact_update_dates", description: "Update Customer Contacted and/or Site Inspected dates on a XactAnalysis assignment", inputSchema: { type: "object", properties: { mfn: { type: "string" }, customer_contacted_date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, site_inspected_date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, note: { type: "string", description: "Optional note to attach to the status update" } }, required: ["mfn"] } },
  { name: "xact_update_workflow_status", description: "Set any workflow status date on a XactAnalysis assignment (customer_contacted, site_inspected, job_sold, job_started, job_not_sold)", inputSchema: { type: "object", properties: { mfn: { type: "string" }, status: { type: "string", enum: ["customer_contacted", "site_inspected", "job_sold", "job_started", "job_not_sold"] }, date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, time: { type: "string", description: "HH:MM in 24h format (optional, defaults to 09:00)" }, note: { type: "string" } }, required: ["mfn", "status", "date"] } },
  { name: "xact_add_note", description: "Add a note to a XactAnalysis assignment", inputSchema: { type: "object", properties: { mfn: { type: "string" }, note: { type: "string" } }, required: ["mfn", "note"] } },
  { name: "xact_get_notes", description: "Get all notes for a XactAnalysis assignment", inputSchema: { type: "object", properties: { mfn: { type: "string" } }, required: ["mfn"] } },

  // FileTrac
  { name: "filetrac_list_companies", description: "List all FileTrac linked companies and their job counts", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "filetrac_list_claims", description: "List claims from FileTrac for a company (company_index: 0=Accelerated, 1=Premier Claims, 2=Stewardship, 3=US Claim Solutions). Use include_closed=true to search all claims including closed/completed ones.", inputSchema: { type: "object", properties: { company_index: { type: "number", description: "0-based index of the company (default 1 = Premier Claims)" }, max_results: { type: "number" }, include_closed: { type: "boolean", description: "Set true to include closed/completed claims (default false = open only)" } }, required: [] } },
  { name: "filetrac_get_claim", description: "Get full details for a specific FileTrac claim by claim ID", inputSchema: { type: "object", properties: { claim_id: { type: "string", description: "Claim ID from URL (claimID=XXXXX)" }, company_index: { type: "number" } }, required: ["claim_id"] } },
  { name: "filetrac_update_claim_dates", description: "Update first contact date, inspection date, and/or claim complete date on a FileTrac claim", inputSchema: { type: "object", properties: { claim_id: { type: "string", description: "Claim ID from claimView URL" }, first_contact_date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, inspection_date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, completed_date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, company_index: { type: "number" } }, required: ["claim_id"] } },
  { name: "filetrac_add_note", description: "Add a diary note to a FileTrac claim. Provide either file_number (8-digit) or claim_id — the file number will be looked up automatically if only claim_id is given.", inputSchema: { type: "object", properties: { file_number: { type: "string", description: "8-digit FileTrac file number (e.g. 81030471) — preferred" }, claim_id: { type: "string", description: "Numeric claim ID (alternative to file_number — file number will be looked up automatically)" }, note: { type: "string" }, category: { type: "string", description: "Note category (e.g. 'Inspection Scheduled', 'Update Contact/Inspection')" }, visible_to_client: { type: "boolean" }, company_index: { type: "number" }, dry_run: { type: "boolean", description: "If true, GET the form and report what WOULD be POSTed (incl. valid category options) without actually submitting" } }, required: ["note"] } },
  { name: "filetrac_submit_time_expense", description: "Submit time and/or expense entries to a FileTrac claim", inputSchema: { type: "object", properties: { file_number: { type: "string", description: "8-digit FileTrac file number" }, date: { type: "string", description: "YYYY-MM-DD or M/D/YYYY" }, hours: { type: "number" }, service_notes: { type: "string" }, expense_amount: { type: "number" }, expense_description: { type: "string" }, company_index: { type: "number" } }, required: ["file_number"] } },
  { name: "filetrac_get_notes", description: "Read all diary/notes entries for a FileTrac claim. Returns all notes with date, author, category, and text.", inputSchema: { type: "object", properties: { claim_id: { type: "string", description: "Numeric FileTrac claim ID (same as used in filetrac_get_claim)" }, company_index: { type: "number", description: "0=Accelerated, 1=Premier Claims (default), 2=Stewardship, 3=US Claim Solutions" } }, required: ["claim_id"] } },
  { name: "filetrac_bulk_get_claims", description: "Get claim details for multiple FileTrac claims in one call (max 20). Uses fast-path ASP session — no browser needed per claim. Returns contact/inspection dates + full detail for each.", inputSchema: { type: "object", properties: { claim_ids: { type: "array", items: { type: "string" }, description: "Array of numeric claim IDs (up to 20)" }, company_index: { type: "number" } }, required: ["claim_ids"] } },
  { name: "filetrac_bulk_add_note", description: "Add notes to multiple FileTrac claims in one call (max 10). Takes an array of {claim_id, note} pairs. Uses a single browser session for efficiency.", inputSchema: { type: "object", properties: { notes: { type: "array", items: { type: "object", properties: { claim_id: { type: "string" }, note: { type: "string" } }, required: ["claim_id", "note"] }, description: "Array of claim_id + note pairs (up to 10)" }, category: { type: "string", description: "Note category to apply to all notes (optional)" }, company_index: { type: "number" } }, required: ["notes"] } },
  { name: "filetrac_refresh_session", description: "Re-authenticate FileTrac via ftevolve.com SSO to refresh expired ASP session cookies. Run this when filetrac_* tools return 'session expired' errors. Refreshes one company (company_index) or all 4 companies if omitted.", inputSchema: { type: "object", properties: { company_index: { type: "number", description: "0=Accelerated, 1=Premier Claims, 2=Stewardship, 3=US Claim Solutions. Omit to refresh all companies." } }, required: [] } },
  { name: "filetrac_dump_html", description: "Debug: fetch any FileTrac URL with cached cookies and return raw HTML, optionally only chunks around a search string. Read-only. Used to reverse-engineer markup when parsers fail.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative path on aspBase, e.g. /system/claimView.asp?claimID=3698545" }, search: { type: "string", description: "Optional substring; only chunks around matches returned" }, context_chars: { type: "number", description: "Chars of context around each match (default 1500)" }, max_matches: { type: "number", description: "Cap on matches returned (default 10)" }, company_index: { type: "number" } }, required: ["path"] } },
  { name: "filetrac_list_documents", description: "List all uploaded documents/reports for a FileTrac claim. Returns report_id, filename, date, file_type, size, on_cloud, and URL for each. Pass report_id to filetrac_download_report to download. Specify company_index if claim is not under Premier Claims (default). US Claim Solutions claims use company_index=3.", inputSchema: { type: "object", properties: { claim_id: { type: "string", description: "FileTrac claim ID (numeric, from claimID= in URL)" }, company_index: { type: "number", description: "0=Accelerated, 1=Premier Claims (default), 2=Stewardship, 3=US Claim Solutions" } }, required: ["claim_id"] } },
  { name: "filetrac_download_report", description: "Download an uploaded FileTrac report/document to a local file path. PREFERRED: supply report_id (from filetrac_list_documents) + company_index — the tool uses reportView.asp to get the correct URL, which works for both local-server and cloud-hosted files. Alternatively, supply report_url for local-server files (on_cloud=false).", inputSchema: { type: "object", properties: { report_id: { type: "string", description: "Report ID from filetrac_list_documents (preferred — use this for reliable downloads, especially cloud files)" }, claim_id: { type: "string", description: "FileTrac claim ID (optional context, not required if report_id provided)" }, report_url: { type: "string", description: "Direct URL from filetrac_list_documents (only for local-server files where on_cloud=false)" }, dest_path: { type: "string", description: "Local file path to save the download (e.g. ~/Desktop/claim_12345.pdf)" }, company_index: { type: "number", description: "0=Accelerated, 1=Premier Claims (default), 2=Stewardship, 3=US Claim Solutions. Must match the claim's company." } }, required: ["dest_path"] } },
  { name: "agent_roll_up_logs", description: "Scan ~/Desktop/dispatch_subagents/*/log.md and append a consolidated summary block to dispatch_master_context.md. Designed for Nina's nightly run.", inputSchema: { type: "object", properties: { max_lines_per_agent: { type: "number", description: "How many tail lines to include per agent log (default 60)" } }, required: [] } },

  // NotaryGadget
  { name: "notarygadget_create_signing", description: "Create a new signing order in NotaryGadget. Supports up to 4 signers. ZIP code is required — include it in location (e.g. '4328 Ben Ave, Studio City, CA 91604') or pass it as the 'zip' parameter.", inputSchema: { type: "object", properties: { customer: { type: "string", description: "Company name (e.g. Pickford Escrow)" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM (24h or 12h)" }, fee: { type: "number", description: "Fee amount (e.g. 150, 250, 75)" }, location: { type: "string", description: "Full address including ZIP (e.g. '4328 Ben Ave, Studio City, CA 91604')" }, city: { type: "string", description: "City (optional if included in location)" }, state: { type: "string", description: "2-letter state code, default CA" }, zip: { type: "string", description: "5-digit ZIP code — REQUIRED if not included in location string" }, signer_names: { type: "array", items: { type: "string" }, description: "All signer names — supports up to 4 (e.g. ['James Maxwell', 'Kevin Herglotz'])" }, package_type: { type: "string", description: "e.g. Seller's package, Buyer's package, Single document" }, notes: { type: "string" } }, required: ["customer", "date", "time", "fee", "location", "signer_names"] } },
  { name: "notarygadget_update_signing", description: "Update an existing NotaryGadget signing without deleting it (preserves invoice number). Provide only the fields to change — others stay as-is.", inputSchema: { type: "object", properties: { signing_id: { type: "string", description: "Numeric NotaryGadget signing ID (required)" }, customer: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM (24h)" }, fee: { type: "number" }, location: { type: "string", description: "Street or full address" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, signer_names: { type: "array", items: { type: "string" }, description: "Replaces ALL signers if provided — include all names you want on file" }, package_type: { type: "string" } }, required: ["signing_id"] } },
  { name: "notarygadget_complete_signing", description: "Record notarial acts for a signing. Always requires notarization_count.", inputSchema: { type: "object", properties: { signing_id: { type: "string", description: "Signing ID (leave blank for most recent)" }, notarization_count: { type: "number", description: "Number of notarial acts performed" }, date: { type: "string", description: "YYYY-MM-DD (optional)" } }, required: ["notarization_count"] } },
  { name: "notarygadget_enter_mileage", description: "Record mileage for a signing (defaults to no mileage if miles not specified)", inputSchema: { type: "object", properties: { signing_id: { type: "string", description: "Signing ID (leave blank for most recent)" }, miles: { type: "number", description: "Miles driven (omit or set to 0 to record 'no mileage')" } }, required: [] } },
  { name: "notarygadget_record_payment", description: "Record a payment received for a signing in NotaryGadget", inputSchema: { type: "object", properties: { signing_id: { type: "string", description: "Signing ID (leave blank for most recent)" }, amount: { type: "number", description: "Payment amount" }, payment_date: { type: "string", description: "YYYY-MM-DD (defaults to today)" }, check_number: { type: "string", description: "Check number (optional)" } }, required: ["amount"] } },
  { name: "notarygadget_get_signings", description: "Get recent signing orders from NotaryGadget", inputSchema: { type: "object", properties: { max_results: { type: "number" }, status: { type: "string", enum: ["pending", "completed", "all"] } }, required: [] } },
  { name: "notarygadget_send_invoice", description: "Email the invoice for a NotaryGadget signing to the customer", inputSchema: { type: "object", properties: { signing_id: { type: "string", description: "Signing ID (leave blank for most recent)" }, to_email: { type: "string", description: "Override recipient email (optional — uses customer email on file by default)" }, subject: { type: "string", description: "Override email subject (optional)" }, body: { type: "string", description: "Override email body (optional)" } }, required: [] } },
  { name: "notarygadget_delete_signing", description: "Permanently delete a signing from NotaryGadget", inputSchema: { type: "object", properties: { signing_id: { type: "string", description: "Signing ID to delete (required)" } }, required: ["signing_id"] } },

  // QuickBooks
  { name: "qb_find_customer", description: "Find a QuickBooks customer by name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "qb_create_customer", description: "Create a new QuickBooks customer", inputSchema: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }, required: ["name"] } },
  { name: "qb_update_customer", description: "Update an existing QuickBooks customer", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }, required: ["customer_id"] } },
  { name: "qb_find_vendor", description: "Find a QuickBooks vendor by name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "qb_create_vendor", description: "Create a new QuickBooks vendor", inputSchema: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }, required: ["name"] } },
  { name: "qb_find_invoice", description: "Find QuickBooks invoices", inputSchema: { type: "object", properties: { customer_name: { type: "string" }, invoice_number: { type: "string" }, max_results: { type: "number" } }, required: [] } },
  { name: "qb_create_invoice", description: "Create a new QuickBooks invoice", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, line_items: { type: "array", items: { type: "object", properties: { description: { type: "string" }, amount: { type: "number" }, quantity: { type: "number" } }, required: ["description", "amount"] } }, due_date: { type: "string" }, memo: { type: "string" } }, required: ["customer_id", "line_items"] } },
  { name: "qb_send_invoice", description: "Send a QuickBooks invoice by email", inputSchema: { type: "object", properties: { invoice_id: { type: "string" }, email: { type: "string" } }, required: ["invoice_id", "email"] } },
  { name: "qb_update_invoice", description: "Update a QuickBooks invoice", inputSchema: { type: "object", properties: { invoice_id: { type: "string" }, due_date: { type: "string" }, memo: { type: "string" } }, required: ["invoice_id"] } },
  { name: "qb_void_invoice", description: "Void a QuickBooks invoice", inputSchema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] } },
  { name: "qb_create_expense", description: "Record a new expense in QuickBooks", inputSchema: { type: "object", properties: { amount: { type: "number" }, vendor_id: { type: "string" }, account_name: { type: "string" }, memo: { type: "string" }, payment_type: { type: "string", enum: ["Cash", "Check", "CreditCard"] } }, required: ["amount"] } },
  { name: "qb_find_expenses", description: "Find recent expenses in QuickBooks", inputSchema: { type: "object", properties: { max_results: { type: "number" } }, required: [] } },
  { name: "qb_create_payment", description: "Record a customer payment in QuickBooks", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, amount: { type: "number" }, invoice_id: { type: "string" }, memo: { type: "string" } }, required: ["customer_id", "amount"] } },
  { name: "qb_find_payments", description: "Find recent payments in QuickBooks", inputSchema: { type: "object", properties: { max_results: { type: "number" } }, required: [] } },
  { name: "qb_profit_and_loss", description: "Get QuickBooks Profit & Loss report", inputSchema: { type: "object", properties: { start_date: { type: "string", description: "YYYY-MM-DD" }, end_date: { type: "string", description: "YYYY-MM-DD" } }, required: [] } },
  { name: "qb_cash_flow", description: "Get QuickBooks Cash Flow report", inputSchema: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" } }, required: [] } },
  { name: "qb_balance_sheet", description: "Get QuickBooks Balance Sheet report", inputSchema: { type: "object", properties: { as_of_date: { type: "string", description: "YYYY-MM-DD" } }, required: [] } },

  // iMessage (macOS local server only — not available on Railway/Linux)
  ...(process.platform === "darwin" ? [
    { name: "imessage_send", description: "Send an iMessage or SMS via macOS Messages app", inputSchema: { type: "object", properties: { recipient: { type: "string" }, message: { type: "string" } }, required: ["recipient", "message"] } },
    { name: "imessage_get_recent_chats", description: "List recent chats from macOS Messages app", inputSchema: { type: "object", properties: { max_results: { type: "number" } }, required: [] } },
  ] as Tool[] : []),

  // HTTP
  { name: "http_request", description: "Make an HTTP request to any URL", inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" }, timeout_ms: { type: "number" } }, required: ["url"] } },
];

// ─── Tool Router ───────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "gmail_send_email": return gmailSendEmail(args as any);
    case "gmail_find_email": return gmailFindEmail(args as any);
    case "gmail_get_email": return gmailGetEmail(args as any);
    case "gmail_reply_to_email": return gmailReplyToEmail(args as any);
    case "gmail_archive_email": return gmailArchiveEmail(args as any);
    case "gmail_download_attachment": return gmailDownloadAttachment(args as any);
    case "calendar_list_events": return calendarListEvents(args as any);
    case "calendar_create_event": return calendarCreateEvent(args as any);
    case "calendar_update_event": return calendarUpdateEvent(args as any);
    case "calendar_delete_event": return calendarDeleteEvent(args as any);
    case "calendar_list_calendars": return calendarListCalendars();
    case "drive_find_file": return driveFindFile(args as any);
    case "drive_get_file": return driveGetFile(args as any);
    case "drive_create_file": return driveCreateFile(args as any);
    case "drive_delete_file": return driveDeleteFile(args as any);
    case "drive_move_file": return driveMoveFile(args as any);
    case "drive_create_folder": return driveCreateFolder(args as any);
    case "drive_upload_file": return driveUploadFile(args as any);
    case "sheets_get_rows": return sheetsGetRows(args as any);
    case "sheets_append_row": return sheetsAppendRow(args as any);
    case "sheets_update_row": return sheetsUpdateRow(args as any);
    case "sheets_clear_range": return sheetsClearRange(args as any);
    case "sheets_lookup_row": return sheetsLookupRow(args as any);
    case "sheets_create_spreadsheet": return sheetsCreateSpreadsheet(args as any);
    case "gdocs_create_document": return gdocsCreateDocument(args as any);
    case "gdocs_get_document": return gdocsGetDocument(args as any);
    case "gdocs_find_document": return gdocsFindDocument(args as any);
    case "gdocs_append_text": return gdocsAppendText(args as any);
    case "gdocs_find_and_replace": return gdocsFindAndReplace(args as any);
    case "tasks_list_tasklists": return tasksListTasklists();
    case "tasks_list_tasks": return tasksListTasks(args as any);
    case "tasks_create_task": return tasksCreateTask(args as any);
    case "tasks_update_task": return tasksUpdateTask(args as any);
    case "tasks_complete_task": return tasksCompleteTask(args as any);
    case "tasks_delete_task": return tasksDeleteTask(args as any);
    case "meet_schedule_meeting": return meetScheduleMeeting(args as any);
    case "meet_get_meeting": return meetGetMeeting(args as any);
    case "meet_cancel_meeting": return meetCancelMeeting(args as any);
    case "notion_list_databases": return notionListDatabases();
    case "notion_find_page": return notionFindPage(args as any);
    case "notion_get_page": return notionGetPage(args as any);
    case "notion_create_page": return notionCreatePage(args as any);
    case "notion_append_to_page": return notionAppendToPage(args as any);
    case "notion_query_database": return notionQueryDatabase(args as any);
    case "notion_create_database_item": return notionCreateDatabaseItem(args as any);
    case "notion_update_database_item": return notionUpdateDatabaseItem(args as any);
    case "notion_update_database_schema": return notionUpdateDatabaseSchema(args as any);
    case "notion_add_database_property": return notionAddDatabaseProperty(args as any);
    case "notion_update_block": return notionUpdateBlock(args as any);
    case "notion_initialize_item_subtasks": return notionInitializeItemSubtasks(args as any);
    case "notion_setup_claims_subtasks": return notionSetupClaimsSubtasks(args as any);
    case "notion_update_subtask": return notionUpdateSubtask(args as any);
    case "notion_get_subtask_status": return notionGetSubtaskStatus(args as any);
    case "notion_list_page_blocks": return notionListPageBlocks(args as any);
    case "notion_archive_block": return notionArchiveBlock(args as any);
    case "notion_insert_after_block": return notionInsertAfterBlock(args as any);
    case "notion_append_multi_block": return notionAppendMultiBlock(args as any);
    case "hubspot_find_contact": return hubspotFindContact(args as any);
    case "hubspot_create_contact": return hubspotCreateContact(args as any);
    case "hubspot_update_contact": return hubspotUpdateContact(args as any);
    case "hubspot_create_deal": return hubspotCreateDeal(args as any);
    case "hubspot_find_deal": return hubspotFindDeal(args as any);
    case "hubspot_update_deal": return hubspotUpdateDeal(args as any);
    case "hubspot_create_company": return hubspotCreateCompany(args as any);
    case "hubspot_find_company": return hubspotFindCompany(args as any);
    case "hubspot_create_note": return hubspotCreateNote(args as any);
    case "gemini_send_prompt": return geminiSendPrompt(args as any);
    case "gemini_chat": return geminiChat(args as any);
    case "gemini_analyze_text": return geminiAnalyzeText(args as any);
    case "notary_get_new_emails": return notaryGetNewEmails(args as any);
    case "notary_send_email": return notarySendEmail(args as any);
    case "notary_mark_email_read": return notaryMarkEmailRead(args as any);
    case "gmail_notary_find_email": return gmailNotaryFindEmail(args as any);
    case "gmail_notary_get_email": return gmailNotaryGetEmail(args as any);
    case "gmail_notary_reply_to_email": return gmailNotaryReplyToEmail(args as any);
    case "gmail_notary_archive_email": return gmailNotaryArchiveEmail(args as any);
    case "notary_check_availability": return notaryCheckAvailability(args as any);
    case "notary_get_travel_time": return notaryGetTravelTime(args as any);
    case "xact_list_assignments": return xactListAssignments(args as any);
    case "xact_get_assignment": return xactGetAssignment(args as any);
    case "xact_update_dates": return xactUpdateDates(args as any);
    case "xact_update_workflow_status": return xactUpdateWorkflowStatus(args as any);
    case "xact_add_note": return xactAddNote(args as any);
    case "xact_get_notes": return xactGetNotes(args as any);
    case "xact_find_assignment_by_claim": return xactFindAssignmentByClaim(args as any);
    case "xact_find_assignment_by_name": return xactFindAssignmentByName(args as any);
    case "filetrac_list_companies": return filetracListCompanies(args as any);
    case "filetrac_list_claims": return filetracListClaims(args as any);
    case "filetrac_get_claim": return filetracGetClaim(args as any);
    case "filetrac_update_claim_dates": return filetracUpdateClaimDates(args as any);
    case "filetrac_add_note": return filetracAddNote(args as any);
    case "filetrac_submit_time_expense": return filetracSubmitTimeExpense(args as any);
    case "filetrac_get_notes": return filetracGetNotes(args as any);
    case "filetrac_bulk_get_claims": return filetracBulkGetClaims(args as any);
    case "filetrac_bulk_add_note": return filetracBulkAddNote(args as any);
    case "filetrac_refresh_session": return filetracRefreshSession(args as any);
    case "filetrac_dump_html": return filetracDumpHtml(args as any);
    case "filetrac_list_documents": return filetracListDocuments(args as any);
    case "filetrac_download_report": return filetracDownloadReport(args as any);
    case "agent_roll_up_logs": return agentRollUpLogs(args as any);
    case "notarygadget_create_signing": return notarygadgetCreateSigning(args as any);
    case "notarygadget_update_signing": return notarygadgetUpdateSigning(args as any);
    case "notarygadget_complete_signing": return notarygadgetCompleteSigning(args as any);
    case "notarygadget_enter_mileage": return notarygadgetEnterMileage(args as any);
    case "notarygadget_record_payment": return notarygadgetRecordPayment(args as any);
    case "notarygadget_get_signings": return notarygadgetGetSignings(args as any);
    case "notarygadget_send_invoice": return notarygadgetSendInvoice(args as any);
    case "notarygadget_delete_signing": return notarygadgetDeleteSigning(args as any);
    case "qb_find_customer": return qbFindCustomer(args as any);
    case "qb_create_customer": return qbCreateCustomer(args as any);
    case "qb_update_customer": return qbUpdateCustomer(args as any);
    case "qb_find_vendor": return qbFindVendor(args as any);
    case "qb_create_vendor": return qbCreateVendor(args as any);
    case "qb_find_invoice": return qbFindInvoice(args as any);
    case "qb_create_invoice": return qbCreateInvoice(args as any);
    case "qb_send_invoice": return qbSendInvoice(args as any);
    case "qb_update_invoice": return qbUpdateInvoice(args as any);
    case "qb_void_invoice": return qbVoidInvoice(args as any);
    case "qb_create_expense": return qbCreateExpense(args as any);
    case "qb_find_expenses": return qbFindExpenses(args as any);
    case "qb_create_payment": return qbCreatePayment(args as any);
    case "qb_find_payments": return qbFindPayments(args as any);
    case "qb_profit_and_loss": return qbProfitAndLoss(args as any);
    case "qb_cash_flow": return qbCashFlow(args as any);
    case "qb_balance_sheet": return qbBalanceSheet(args as any);
    case "imessage_send": return imessageSend(args as any);
    case "imessage_get_recent_chats": return imessageGetRecentChats(args as any);
    case "http_request": return httpRequest(args as any);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Server Factory ────────────────────────────────────────────────────────────

function createServer() {
  const server = new Server(
    { name: "mcp-automation", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await callTool(name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

// ─── Transport: HTTP/SSE (Railway) or stdio (local) ───────────────────────────

const PORT = process.env.PORT;

if (PORT) {
  // Cloud mode: HTTP + SSE
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  // Raw SSE test endpoint — bypasses MCP SDK to test tunnel streaming
  app.get("/sse-test", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.status(200);
    res.write("event: ping\ndata: tunnel-working\n\n");
    const interval = setInterval(() => res.write(": heartbeat\n\n"), 5000);
    res.on("close", () => clearInterval(interval));
  });

  app.get("/sse", async (req, res) => {
    res.setHeader("X-Accel-Buffering", "no");
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => transports.delete(transport.sessionId));

    const server = createServer();
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).send("Session not found"); return; }
    await transport.handlePostMessage(req, res);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", tools: TOOLS.length }));

  // QuickBooks OAuth callback — used during production auth flow
  app.get("/qb-callback", async (req, res) => {
    const code = req.query.code as string;
    const realmId = req.query.realmId as string;
    const error = req.query.error as string;

    if (error) {
      res.send(`<h2>QuickBooks auth error: ${error}</h2>`);
      return;
    }
    if (!code || !realmId) {
      res.send("<h2>Missing code or realmId</h2>");
      return;
    }

    const clientId = process.env.QUICKBOOKS_CLIENT_ID!;
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET!;
    const redirectUri = `https://mcp-automation-production.up.railway.app/qb-callback`;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenRes.json() as any;
    if (tokens.error) {
      res.send(`<h2>Token exchange failed: ${tokens.error}</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>`);
      return;
    }

    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      realm_id: realmId,
    };

    res.send(`
      <h2>QuickBooks Connected!</h2>
      <p>Copy the token below and paste it into Railway as <strong>QUICKBOOKS_TOKEN_JSON</strong>:</p>
      <textarea rows="10" cols="80" onclick="this.select()">${JSON.stringify(tokenData)}</textarea>
      <p>After updating Railway, you can close this page.</p>
    `);
  });

  app.get("/diagnose", async (_req, res) => {
    const results: Record<string, string> = {};

    // Check which env vars are present
    const vars = [
      "GOOGLE_CREDENTIALS_JSON", "GOOGLE_TOKEN_JSON", "GOOGLE_NOTARY_TOKEN_JSON",
      "QUICKBOOKS_TOKEN_JSON", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET",
      "NOTION_TOKEN", "HUBSPOT_TOKEN", "GOOGLE_AI_API_KEY",
      "NOTARYGADGET_EMAIL", "NOTARYGADGET_PASSWORD",
      "GOOGLE_MAPS_API_KEY", "NOTARY_HOME_ADDRESS",
    ];
    for (const v of vars) {
      results[v] = process.env[v] ? "SET" : "MISSING";
    }

    // Try parsing JSON vars
    for (const v of ["GOOGLE_CREDENTIALS_JSON", "GOOGLE_TOKEN_JSON", "GOOGLE_NOTARY_TOKEN_JSON", "QUICKBOOKS_TOKEN_JSON"]) {
      if (process.env[v]) {
        try { JSON.parse(process.env[v]!); results[v] = "SET (valid JSON)"; }
        catch (e) { results[v] = `SET (INVALID JSON: ${(e as Error).message.substring(0, 60)})`; }
      }
    }

    // Try Google auth
    try {
      const { getGoogleAuthClient } = await import("./auth/google.js");
      const auth = await getGoogleAuthClient();
      const { google } = await import("googleapis");
      const gmail = google.gmail({ version: "v1", auth });
      await gmail.users.getProfile({ userId: "me" });
      results["GOOGLE_AUTH_TEST"] = "OK";
    } catch (e) { results["GOOGLE_AUTH_TEST"] = `FAIL: ${(e as Error).message.substring(0, 100)}`; }

    // Try Notary Gmail auth
    try {
      const { getNotaryGmailClient } = await import("./auth/google-notary.js");
      const auth = await getNotaryGmailClient();
      const { google } = await import("googleapis");
      const gmail = google.gmail({ version: "v1", auth });
      await gmail.users.getProfile({ userId: "me" });
      results["NOTARY_GMAIL_TEST"] = "OK";
    } catch (e) { results["NOTARY_GMAIL_TEST"] = `FAIL: ${(e as Error).message.substring(0, 100)}`; }

    res.json(results);
  });

  const httpServer = app.listen(Number(PORT), () => {
    console.log(`mcp-automation server running on port ${PORT} (HTTP/SSE mode)`);
  });
  // Disable Nagle's algorithm so small SSE packets aren't buffered on localhost
  httpServer.on("connection", (socket) => socket.setNoDelay(true));
} else {
  // Local mode: stdio
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-automation server running on stdio");
}
