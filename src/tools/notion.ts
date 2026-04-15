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
async function notionFetch(path: string, method: "GET" | "POST" = "GET", body?: object): Promise<any> {
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
}): Promise<CallToolResult> {
  const notion = getNotion();
  await notion.blocks.children.append({
    block_id: args.page_id,
    children: [{
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: args.content } }],
      },
    }],
  });
  return ok(`Content appended to page ${args.page_id}.`);
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

export async function notionCreateDatabaseItem(args: {
  database_id: string;
  title: string;
  title_property?: string;
  properties?: Record<string, string>;
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

  const notion = getNotion();
  const res: any = await notion.pages.create({
    parent: { database_id: args.database_id },
    properties,
  });

  return ok(`Database item created: ${args.title}\nID: ${res.id}\nURL: ${res.url}`);
}
