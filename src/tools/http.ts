import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function httpRequest(args: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}): Promise<CallToolResult> {
  const method = (args.method ?? "GET").toUpperCase();
  const timeout = args.timeout_ms ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(args.url, {
      method,
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text();

    let displayBody = rawBody;
    if (contentType.includes("application/json") && rawBody) {
      try {
        displayBody = JSON.stringify(JSON.parse(rawBody), null, 2);
      } catch {
        // leave as-is
      }
    }

    // Truncate very large responses
    const truncated = displayBody.length > 10_000;
    if (truncated) displayBody = displayBody.slice(0, 10_000) + "\n... (truncated)";

    return ok(
      [
        `Status: ${response.status} ${response.statusText}`,
        `Content-Type: ${contentType}`,
        "",
        displayBody,
      ].join("\n")
    );
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw err;
  }
}
