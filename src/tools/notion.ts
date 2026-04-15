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
  type?: "page" | "database" | "all";
}): Promise<CallToolResult> {
  const notion = getNotion();
  const limit = args.max_results ?? 50;
  const searchType = args.type ?? "all";

  // Search pages and/or databases
  const searches: Promise<any>[] = [];
  if (searchType === "page" || searchType === "all") {
    searches.push(notion.search({
      query: args.query,
      page_size: Math.min(limit, 100),
      filter: { property: "object", value: "page" },
    }));
  }
  if (searchType === "database" || searchType === "all") {
    searches.push((notion as any).search({
      query: args.query,
      page_size: Math.min(limit, 100),
      filter: { property: "object", value: "database" },
    }));
  }

  const results = (await Promise.all(searches)).flatMap((r: any) => r.results);
  if (results.length === 0) return ok("No pages or databases found.");

  const lines = results.slice(0, limit).map((r: any) => {
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

  // Also list all properties for full visibility
  const props = Object.entries(page.properties ?? {}).map(([key, val]: [string, any]) => {
    let value = "";
    if (val.title) value = extractPlainText(val.title);
    else if (val.rich_text) value = extractPlainText(val.rich_text);
    else if (val.select) value = val.select?.name ?? "";
    else if (val.multi_select) value = val.multi_select.map((s: any) => s.name).join(", ");
    else if (val.date) value = val.date?.start ?? "";
    else if (val.number) value = String(val.number ?? "");
    else if (val.checkbox) value = val.checkbox ? "Yes" : "No";
    else if (val.url) value = val.url ?? "";
    else if (val.email) value = val.email ?? "";
    else if (val.phone_number) value = val.phone_number ?? "";
    else if (val.people) value = val.people.map((p: any) => p.name ?? p.id).join(", ");
    else if (val.relation) value = val.relation.map((r: any) => r.id).join(", ");
    else if (val.status) value = val.status?.name ?? "";
    else if (val.formula) value = String(val.formula?.string ?? val.formula?.number ?? val.formula?.boolean ?? "");
    if (!value) return null;
    return `  ${key}: ${value}`;
  }).filter(Boolean);

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
  filter_property?: string;
  filter_value?: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const notion = getNotion();
  const limit = args.max_results ?? 200; // default: get up to 200 items

  const allResults: any[] = [];
  let cursor: string | undefined;

  do {
    const res: any = await (notion as any).databases.query({
      database_id: args.database_id,
      page_size: Math.min(100, limit - allResults.length),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    allResults.push(...res.results);
    cursor = res.has_more && allResults.length < limit ? res.next_cursor : undefined;
  } while (cursor);

  if (allResults.length === 0) return ok("No items found in database.");

  const lines = allResults.map((r: any) => {
    const props = Object.entries(r.properties).map(([key, val]: [string, any]) => {
      let value = "";
      if (val.title) value = extractPlainText(val.title);
      else if (val.rich_text) value = extractPlainText(val.rich_text);
      else if (val.select) value = val.select?.name ?? "";
      else if (val.multi_select) value = val.multi_select.map((s: any) => s.name).join(", ");
      else if (val.date) value = val.date?.start ?? "";
      else if (val.number) value = String(val.number ?? "");
      else if (val.checkbox) value = val.checkbox ? "Yes" : "No";
      else if (val.url) value = val.url ?? "";
      else if (val.email) value = val.email ?? "";
      else if (val.phone_number) value = val.phone_number ?? "";
      else if (val.people) value = val.people.map((p: any) => p.name ?? p.id).join(", ");
      else if (val.relation) value = val.relation.map((rv: any) => rv.id).join(", ");
      else if (val.status) value = val.status?.name ?? "";
      else if (val.formula) value = String(val.formula?.string ?? val.formula?.number ?? val.formula?.boolean ?? "");
      if (!value) return null;
      return `  ${key}: ${value}`;
    }).filter(Boolean);
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
  const notion = getNotion();

  // Look up the database to find the actual title property name
  let titlePropName = args.title_property ?? "title";
  try {
    const db: any = await (notion as any).databases.retrieve({ database_id: args.database_id });
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

  const res: any = await notion.pages.create({
    parent: { database_id: args.database_id },
    properties,
  });

  return ok(`Database item created: ${args.title}\nID: ${res.id}\nURL: ${res.url}`);
}
