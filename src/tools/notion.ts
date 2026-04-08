import { Client } from "@notionhq/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function getNotion() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN environment variable not set.");
  return new Client({ auth: token });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function extractPlainText(richText: Array<{ plain_text?: string }>) {
  return richText.map((t) => t.plain_text ?? "").join("");
}

export async function notionFindPage(args: {
  query: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const notion = getNotion();
  const res = await notion.search({
    query: args.query,
    page_size: args.max_results ?? 10,
    filter: { property: "object", value: "page" },
  });

  if (res.results.length === 0) return ok("No pages found.");

  const lines = res.results.map((r: any) => {
    const title = r.properties?.title?.title?.[0]?.plain_text ??
      r.properties?.Name?.title?.[0]?.plain_text ?? "(untitled)";
    return `ID: ${r.id}\nTitle: ${title}\nURL: ${r.url}`;
  });
  return ok(lines.join("\n\n---\n\n"));
}

export async function notionGetPage(args: {
  page_id: string;
}): Promise<CallToolResult> {
  const notion = getNotion();
  const page: any = await notion.pages.retrieve({ page_id: args.page_id });

  const title = page.properties?.title?.title?.[0]?.plain_text ??
    page.properties?.Name?.title?.[0]?.plain_text ?? "(untitled)";

  // Get page content blocks
  const blocks = await notion.blocks.children.list({ block_id: args.page_id });
  const lines: string[] = [];

  for (const block of blocks.results as any[]) {
    const type = block.type;
    const content = block[type];
    if (content?.rich_text) {
      const text = extractPlainText(content.rich_text);
      if (text) lines.push(text);
    }
  }

  return ok(`Title: ${title}\nID: ${page.id}\nURL: ${page.url}\n\n${lines.join("\n")}`);
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
  filter_property?: string;
  filter_value?: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const notion = getNotion();

  const res = await (notion as any).databases.query({
    database_id: args.database_id,
    page_size: args.max_results ?? 20,
  });

  if (res.results.length === 0) return ok("No items found in database.");

  const lines = res.results.map((r: any) => {
    const props = Object.entries(r.properties).map(([key, val]: [string, any]) => {
      let value = "";
      if (val.title) value = extractPlainText(val.title);
      else if (val.rich_text) value = extractPlainText(val.rich_text);
      else if (val.select) value = val.select?.name ?? "";
      else if (val.multi_select) value = val.multi_select.map((s: any) => s.name).join(", ");
      else if (val.date) value = val.date?.start ?? "";
      else if (val.number) value = String(val.number ?? "");
      else if (val.checkbox) value = val.checkbox ? "Yes" : "No";
      return `  ${key}: ${value}`;
    });
    return `ID: ${r.id}\n${props.join("\n")}`;
  });

  return ok(lines.join("\n\n---\n\n"));
}

export async function notionCreateDatabaseItem(args: {
  database_id: string;
  title: string;
  properties?: Record<string, string>;
}): Promise<CallToolResult> {
  const notion = getNotion();

  const properties: any = {
    title: { title: [{ type: "text", text: { content: args.title } }] },
  };

  if (args.properties) {
    for (const [key, value] of Object.entries(args.properties)) {
      properties[key] = { rich_text: [{ type: "text", text: { content: value } }] };
    }
  }

  const res: any = await notion.pages.create({
    parent: { database_id: args.database_id },
    properties,
  });

  return ok(`Database item created: ${args.title}\nID: ${res.id}\nURL: ${res.url}`);
}
