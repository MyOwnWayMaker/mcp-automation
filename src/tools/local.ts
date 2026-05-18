import fs from "fs";
import path from "path";
import os from "os";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Scans ~/Desktop/dispatch_subagents/ for agent log.md files and appends a
 * consolidated summary block to dispatch_master_context.md.
 * Designed for Nina's nightly roll-up run.
 */
export async function agentRollUpLogs(args: {
  max_lines_per_agent?: number;  // how many tail lines to include per log (default 60)
}): Promise<CallToolResult> {
  const subagentsDir = path.join(os.homedir(), "Desktop/dispatch_subagents");
  const masterContextPath = path.join(
    os.homedir(),
    "Desktop/Dispatch and Claude Communication/dispatch_master_context.md"
  );
  const maxLines = args.max_lines_per_agent ?? 60;

  if (!fs.existsSync(subagentsDir)) {
    return ok(`No dispatch_subagents directory found at: ${subagentsDir}`);
  }

  const agentDirs = fs.readdirSync(subagentsDir).filter((d) => {
    try {
      return fs.statSync(path.join(subagentsDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  const summaries: string[] = [];

  for (const agentName of agentDirs.sort()) {
    const logPath = path.join(subagentsDir, agentName, "log.md");
    if (!fs.existsSync(logPath)) continue;

    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.split("\n");
    const excerpt = lines.slice(-maxLines).join("\n").trim();
    const lastModified = fs.statSync(logPath).mtime.toISOString().replace("T", " ").substring(0, 19);

    summaries.push(
      `### ${agentName}\n_Last modified: ${lastModified}_\n\n${excerpt}`
    );
  }

  if (summaries.length === 0) {
    return ok(
      `No agent log.md files found under: ${subagentsDir}\n` +
      `Directories scanned: ${agentDirs.join(", ") || "(none)"}`
    );
  }

  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
  const block =
    `\n\n---\n## Agent Log Roll-Up — ${timestamp} UTC\n\n` +
    summaries.join("\n\n---\n\n") +
    `\n\n---`;

  if (!fs.existsSync(masterContextPath)) {
    return ok(
      `dispatch_master_context.md not found at: ${masterContextPath}\n` +
      `Agents found: ${agentDirs.join(", ")}\n\n` +
      `Roll-up content that would have been appended:\n${block}`
    );
  }

  fs.appendFileSync(masterContextPath, block, "utf-8");

  return ok(
    `✅ Log roll-up appended to dispatch_master_context.md\n` +
    `Agents summarized (${summaries.length}): ${agentDirs.filter(d => fs.existsSync(path.join(subagentsDir, d, "log.md"))).join(", ")}\n` +
    `Timestamp: ${timestamp}`
  );
}
