/**
 * Updates FILETRAC_SESSION_JSON, XACTANALYSIS_SESSION_JSON, and GOOGLE_NOTARY_TOKEN_JSON on Railway.
 * Run from mcp-automation folder: node scripts/update-railway-sessions.mjs
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const files = {
  FILETRAC_SESSION_JSON:     path.join(root, "filetrac_session.json"),
  XACTANALYSIS_SESSION_JSON: path.join(root, "xactanalysis_session.json"),
  GOOGLE_NOTARY_TOKEN_JSON:  path.join(root, "token_notary.json"),
};

for (const [key, filePath] of Object.entries(files)) {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  Skipping ${key} — file not found`);
    continue;
  }

  const value = fs.readFileSync(filePath, "utf8").trim();

  console.log(`Updating ${key} (${value.length} chars)...`);

  // Pass as array — no shell interpretation, no escaping issues
  const result = spawnSync(
    "railway",
    ["variables", "set", `${key}=${value}`],
    { cwd: root, stdio: "inherit", maxBuffer: 20 * 1024 * 1024 }
  );

  if (result.status === 0) {
    console.log(`✅  ${key} updated\n`);
  } else {
    console.error(`❌  Failed to update ${key} (exit code ${result.status})\n`);
  }
}

console.log("Done — Railway will redeploy automatically.");
