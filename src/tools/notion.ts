import { Client } from "@notionhq/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function getToken(): string {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN environment variable not set.");
  return token;
}

function getNotion() {
  return new Client({ auth: getToken() });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function extractPlainText(richText: Array<{ plain_text?: string }>) {
  return richText.map((t) => t.plain_text ?? "").join("");
}

// Direct REST API helper — SDK v5 removed databases.query and other endpoints
async function notionFetch(path: string, method: "GET" | "POST" | "PATCH" = "GET", body?: object): Promise<any> {
  const token = getToken();
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion API error ${res.status}: ${err}`);
  }
  return res.json();
}

function formatProps(properties: Record<string, any>): string[] {
  return Object.entries(properties).map(([key, val]: [string, any]) => {
    let value = "";
    if (val.title) value = extractPlainText(val.title);
    else if (val.rich_text) value = extractPlainText(val.rich_text);
    else if (val.select) value = val.select?.name ?? "";
    else if (val.multi_select) value = val.multi_select.map((s: any) => s.name).join(", ");
    else if (val.date) value = val.date?.start ?? "";
    else if (val.number != null) value = String(val.number);
    else if (val.checkbox != null) value = val.checkbox ? "Yes" : "No";
    else if (val.url) value = val.url ?? "";
    else if (val.email) value = val.email ?? "";
    else if (val.phone_number) value = val.phone_number ?? "";
    else if (val.people) value = val.people.map((p: any) => p.name ?? p.id).join(", ");
    else if (val.relation) value = val.relation.map((rv: any) => rv.id).join(", ");
    else if (val.status) value = val.status?.name ?? "";
    else if (val.formula) value = String(val.formula?.string ?? val.formula?.number ?? val.formula?.boolean ?? "");
    if (!value) return null;
    return `  ${key}: ${value}`;
  }).filter(Boolean) as string[];
}

export async function notionListDatabases(): Promise<CallToolResult> {
  const allDbs: any[] = [];
  let cursor: string | undefined;

  do {
    const body: any = { filter: { value: "database", property: "object" }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch("/search", "POST", body);
    allDbs.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  if (allDbs.length === 0) return ok("No databases found in workspace.");

  const lines = allDbs.map((db: any) => {
    const title = db.title?.[0]?.plain_text ?? "(untitled)";
    return `ID: ${db.id}\nTitle: ${title}\nURL: ${db.url}`;
  });

  return ok(`Found ${allDbs.length} database(s):\n\n` + lines.join("\n\n---\n\n"));
}

export async function notionFindPage(args: {
  query: string;
  max_results?: number;
  type?: "page" | "database" | "all";
}): Promise<CallToolResult> {
  const limit = args.max_results ?? 50;
  const searchType = args.type ?? "all";

  const body: any = { query: args.query, page_size: Math.min(limit, 100) };
  if (searchType === "page") body.filter = { property: "object", value: "page" };
  if (searchType === "database") body.filter = { property: "object", value: "database" };

  const res = await notionFetch("/search", "POST", body);

  if (!res.results || res.results.length === 0) return ok("No pages or databases found.");

  const lines = res.results.slice(0, limit).map((r: any) => {
    const titleProp = r.properties?.title?.title?.[0]?.plain_text ??
      r.properties?.Name?.title?.[0]?.plain_text ??
      r.title?.[0]?.plain_text ?? "(untitled)";
    return `Type: ${r.object}\nID: ${r.id}\nTitle: ${titleProp}\nURL: ${r.url}`;
  });
  return ok(`Found ${lines.length} result(s):\n\n` + lines.join("\n\n---\n\n"));
}

export async function notionGetPage(args: {
  page_id: string;
}): Promise<CallToolResult> {
  const notion = getNotion();
  const page: any = await notion.pages.retrieve({ page_id: args.page_id });

  const title = page.properties?.title?.title?.[0]?.plain_text ??
    page.properties?.Name?.title?.[0]?.plain_text ?? "(untitled)";

  // Get ALL page content blocks via pagination
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const blocks: any = await notion.blocks.children.list({
      block_id: args.page_id,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const block of blocks.results as any[]) {
      const type = block.type;
      const content = block[type];
      if (content?.rich_text) {
        const text = extractPlainText(content.rich_text);
        if (text) lines.push(text);
      }
    }
    cursor = blocks.has_more ? blocks.next_cursor : undefined;
  } while (cursor);

  const props = formatProps(page.properties ?? {});
  const propsSection = props.length > 0 ? `\n\nProperties:\n${props.join("\n")}` : "";
  const contentSection = lines.length > 0 ? `\n\nContent:\n${lines.join("\n")}` : "";

  return ok(`Title: ${title}\nID: ${page.id}\nURL: ${page.url}${propsSection}${contentSection}`);
}

export async function notionCreatePage(args: {
  parent_page_id?: string;
  parent_database_id?: string;
  title: string;
  content?: string;
}): Promise<CallToolResult> {
  const notion = getNotion();

  if (!args.parent_page_id && !args.parent_database_id) {
    throw new Error("Provide either parent_page_id or parent_database_id.");
  }

  const parent = args.parent_database_id
    ? { database_id: args.parent_database_id }
    : { page_id: args.parent_page_id! };

  const children: any[] = args.content
    ? [{
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: args.content } }],
        },
      }]
    : [];

  const res: any = await notion.pages.create({
    parent,
    properties: {
      title: { title: [{ type: "text", text: { content: args.title } }] },
    },
    children,
  });

  return ok(`Page created: ${args.title}\nID: ${res.id}\nURL: ${res.url}`);
}

export async function notionAppendToPage(args: {
  page_id: string;
  content: string;
  block_type?: "paragraph" | "to_do" | "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item" | "numbered_list_item";
}): Promise<CallToolResult> {
  const notion = getNotion();
  const type = args.block_type ?? "paragraph";
  const richText = [{ type: "text", text: { content: args.content } }];
  const block: any = { object: "block", type, [type]: { rich_text: richText } };
  if (type === "to_do") block[type].checked = false;

  await notion.blocks.children.append({ block_id: args.page_id, children: [block] });
  return ok(`${type === "to_do" ? "To-do item" : "Content"} appended to page ${args.page_id}.`);
}

export async function notionQueryDatabase(args: {
  database_id: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const limit = args.max_results ?? 200;
  const allResults: any[] = [];
  let cursor: string | undefined;

  do {
    const body: any = { page_size: Math.min(100, limit - allResults.length) };
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch(`/databases/${args.database_id}/query`, "POST", body);
    allResults.push(...res.results);
    cursor = res.has_more && allResults.length < limit ? res.next_cursor : undefined;
  } while (cursor);

  if (allResults.length === 0) return ok("No items found in database.");

  const lines = allResults.map((r: any) => {
    const props = formatProps(r.properties ?? {});
    return `ID: ${r.id}\nURL: ${r.url}\n${props.join("\n")}`;
  });

  return ok(`Total items: ${allResults.length}\n\n` + lines.join("\n\n---\n\n"));
}

export async function notionUpdateDatabaseItem(args: {
  page_id: string;
  properties: Record<string, { type: string; value: string | null }>;
}): Promise<CallToolResult> {
  // Build the Notion properties payload from typed key-value pairs
  const formatted: any = {};

  for (const [key, { type, value }] of Object.entries(args.properties)) {
    switch (type) {
      case "select":
        formatted[key] = value ? { select: { name: value } } : { select: null };
        break;
      case "multi_select":
        formatted[key] = { multi_select: value ? value.split(",").map((v) => ({ name: v.trim() })) : [] };
        break;
      case "title":
        formatted[key] = { title: [{ type: "text", text: { content: value ?? "" } }] };
        break;
      case "rich_text":
      case "text":
        formatted[key] = { rich_text: [{ type: "text", text: { content: value ?? "" } }] };
        break;
      case "date":
        formatted[key] = value ? { date: { start: value } } : { date: null };
        break;
      case "number":
        formatted[key] = { number: value !== null ? Number(value) : null };
        break;
      case "checkbox":
        formatted[key] = { checkbox: value === "true" };
        break;
      case "url":
        formatted[key] = { url: value };
        break;
      case "email":
        formatted[key] = { email: value };
        break;
      case "phone_number":
        formatted[key] = { phone_number: value };
        break;
      case "status":
        formatted[key] = { status: { name: value } };
        break;
      default:
        throw new Error(`Unsupported property type: ${type}. Supported: select, multi_select, title, rich_text, text, date, number, checkbox, url, email, phone_number, status`);
    }
  }

  const res = await notionFetch(`/pages/${args.page_id}`, "PATCH", { properties: formatted });
  return ok(`Updated page ${args.page_id}\nURL: ${res.url}`);
}

export async function notionUpdateDatabaseSchema(args: {
  database_id: string;
  property_name: string;
  select_options: Array<{ name: string; color?: string }>;
}): Promise<CallToolResult> {
  // Update a select/multi_select property's options on a database
  // Valid Notion colors: default, gray, brown, orange, yellow, green, blue, purple, pink, red
  const body = {
    properties: {
      [args.property_name]: {
        select: {
          options: args.select_options.map((opt) => ({
            name: opt.name,
            ...(opt.color ? { color: opt.color } : {}),
          })),
        },
      },
    },
  };

  await notionFetch(`/databases/${args.database_id}`, "PATCH", body);
  return ok(`Updated database ${args.database_id}: property "${args.property_name}" now has ${args.select_options.length} options: ${args.select_options.map((o) => o.name).join(", ")}`);
}

export async function notionCreateDatabaseItem(args: {
  database_id: string;
  title: string;
  title_property?: string;
  properties?: Record<string, string>;
  init_subtasks?: boolean;
}): Promise<CallToolResult> {
  // Look up the database to find the actual title property name
  let titlePropName = args.title_property ?? "title";
  try {
    const db = await notionFetch(`/databases/${args.database_id}`);
    const titleProp = Object.entries(db.properties ?? {}).find(([, v]: [string, any]) => v.type === "title");
    if (titleProp) titlePropName = titleProp[0];
  } catch { /* use default */ }

  const properties: any = {
    [titlePropName]: { title: [{ type: "text", text: { content: args.title } }] },
  };

  if (args.properties) {
    for (const [key, value] of Object.entries(args.properties)) {
      properties[key] = { rich_text: [{ type: "text", text: { content: value } }] };
    }
  }

  // Initialize subtask statuses inline if requested
  if (args.init_subtasks) {
    for (const subtask of ["Inspection", "Photo Report", "Sketch", "Estimate", "Narrative"]) {
      properties[`${subtask} Status`] = { select: { name: "Not Started" } };
    }
  }

  const notion = getNotion();
  const res: any = await notion.pages.create({
    parent: { database_id: args.database_id },
    properties,
  });

  return ok(
    `Database item created: ${args.title}\nID: ${res.id}\nURL: ${res.url}` +
    (args.init_subtasks ? "\nSubtasks initialized: Inspection, Photo Report, Sketch, Estimate, Narrative → Not Started" : "")
  );
}

// ─── Subtask + Time Tracking ───────────────────────────────────────────────────

const STANDARD_SUBTASKS = ["Inspection", "Photo Report", "Sketch", "Estimate", "Narrative"] as const;

function formatDuration(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Sets up the 5 standard subtask property groups on a claim database.
 * Each subtask gets: checkbox, Status (select), Start (text), Hours (number).
 * Run once per database — safe to re-run, existing properties are unchanged.
 */
export async function notionSetupClaimsSubtasks(args: {
  database_id: string;
}): Promise<CallToolResult> {
  const statusOptions = [
    { name: "Not Started", color: "gray" },
    { name: "In Progress", color: "blue" },
    { name: "Paused", color: "yellow" },
    { name: "Complete", color: "green" },
  ];

  const properties: Record<string, any> = {};
  for (const subtask of STANDARD_SUBTASKS) {
    properties[subtask] = { checkbox: {} };
    properties[`${subtask} Status`] = { select: { options: statusOptions } };
    properties[`${subtask} Start`] = { rich_text: {} };
    properties[`${subtask} Hours`] = { number: { format: "number" } };
  }

  await notionFetch(`/databases/${args.database_id}`, "PATCH", { properties });
  return ok(
    `Set up subtask properties on database ${args.database_id}.\n` +
    `Added for each of: ${STANDARD_SUBTASKS.join(", ")}\n` +
    `Properties per subtask: checkbox, Status, Start, Hours`
  );
}

/**
 * Start, pause, or complete a subtask on a claim. Tracks time automatically.
 * - start: records session start time, sets status In Progress
 * - pause: computes elapsed, adds to Hours, clears start, sets Paused
 * - complete: computes elapsed, adds to Hours, clears start, checks checkbox, sets Complete
 */
export async function notionUpdateSubtask(args: {
  page_id: string;
  subtask: string;
  action: "start" | "pause" | "complete";
}): Promise<CallToolResult> {
  // Read current page state
  const page = await notionFetch(`/pages/${args.page_id}`);
  const props = page.properties ?? {};

  const statusKey   = `${args.subtask} Status`;
  const startKey    = `${args.subtask} Start`;
  const hoursKey    = `${args.subtask} Hours`;
  const checkboxKey = args.subtask;

  const currentHours     = props[hoursKey]?.number ?? 0;
  const currentStartText = props[startKey]?.rich_text?.[0]?.plain_text ?? "";

  const updates: Record<string, any> = {};
  const now = new Date();
  let message = "";

  if (args.action === "start") {
    const alreadyRunning = currentStartText !== "";
    updates[statusKey] = { select: { name: "In Progress" } };
    if (!alreadyRunning) {
      updates[startKey] = { rich_text: [{ type: "text", text: { content: now.toISOString() } }] };
    }
    const runningNote = alreadyRunning ? " (timer was already running — not reset)" : "";
    message = `${args.subtask} → In Progress${runningNote}. Accumulated so far: ${formatDuration(currentHours)}`;

  } else if (args.action === "pause" || args.action === "complete") {
    let sessionHours = 0;
    if (currentStartText) {
      const startTime = new Date(currentStartText);
      sessionHours = (now.getTime() - startTime.getTime()) / 3600000;
    }
    const totalHours = Math.round((currentHours + sessionHours) * 100) / 100;

    updates[hoursKey] = { number: totalHours };
    updates[startKey] = { rich_text: [] }; // clear session start

    if (args.action === "pause") {
      updates[statusKey] = { select: { name: "Paused" } };
      message = `${args.subtask} → Paused.\nSession: ${formatDuration(sessionHours)} | Total: ${formatDuration(totalHours)}`;
    } else {
      updates[statusKey] = { select: { name: "Complete" } };
      updates[checkboxKey] = { checkbox: true };
      message = `${args.subtask} → Complete ✓\nFinal session: ${formatDuration(sessionHours)} | Total time: ${formatDuration(totalHours)}`;
    }
  } else {
    throw new Error(`Unknown action "${args.action}". Use: start, pause, complete`);
  }

  await notionFetch(`/pages/${args.page_id}`, "PATCH", { properties: updates });
  return ok(message);
}

/**
 * Returns a summary of all subtask statuses and hours for a claim page.
 */
export async function notionGetSubtaskStatus(args: {
  page_id: string;
}): Promise<CallToolResult> {
  const page = await notionFetch(`/pages/${args.page_id}`);
  const props = page.properties ?? {};

  // Detect subtasks: anything with a matching "{name} Status" property
  const allSubtasks = STANDARD_SUBTASKS.filter(s => props[`${s} Status`]);

  if (allSubtasks.length === 0) {
    return ok("No subtask properties found on this page. Run notion_setup_claims_subtasks first.");
  }

  const lines = allSubtasks.map(subtask => {
    const status = props[`${subtask} Status`]?.select?.name ?? "Not Started";
    const hours  = props[`${subtask} Hours`]?.number ?? 0;
    const start  = props[`${subtask} Start`]?.rich_text?.[0]?.plain_text ?? "";
    const done   = props[subtask]?.checkbox ? "✓" : "○";
    const timer  = start ? " ⏱ running" : "";
    return `${done} ${subtask}: ${status} — ${formatDuration(hours)}${timer}`;
  });

  const totalHours = allSubtasks.reduce((sum, s) => sum + (props[`${s} Hours`]?.number ?? 0), 0);
  return ok(`Subtask Status:\n${lines.join("\n")}\n\nTotal time tracked: ${formatDuration(totalHours)}`);
}
