// env.mjs — single source for loading /Users/dino/mcp-automation/.env.local.
// Import once at top of any pipeline entry script.

import fs from "node:fs";

const ENV_PATH = process.env.PIPELINE_ENV_PATH ?? "/Users/dino/mcp-automation/.env.local";

if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
