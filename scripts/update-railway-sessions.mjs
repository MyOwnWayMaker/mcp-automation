/**
 * Updates FILETRAC_SESSION_JSON, XACTANALYSIS_SESSION_JSON, and GOOGLE_NOTARY_TOKEN_JSON on Railway.
 * Run from mcp-automation folder: node scripts/update-railway-sessions.mjs
 *
 * Why this script is necessary: the auth scripts (auth-filetrac.mjs,
 * auth-xactanalysis.mjs, etc.) write session files locally but the deployed
 * MCP server on Railway reads from env vars. Without pushing the local file
 * up to Railway, the deployed server keeps using the stale session.
 *
 * Implementation: calls Railway's GraphQL API directly using credentials
 * from ~/.railway/config.json (or %USERPROFILE%\.railway\config.json on
 * Windows). Bypasses the CLI entirely — avoids Windows spawn issues with
 * .cmd files, command-line length limits on large session JSONs, and CLI
 * version syntax differences (v3 vs v4).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const files = {
  FILETRAC_SESSION_JSON:     path.join(root, "filetrac_session.json"),
  XACTANALYSIS_SESSION_JSON: path.join(root, "xactanalysis_session.json"),
  GOOGLE_NOTARY_TOKEN_JSON:  path.join(root, "token_notary.json"),
};

// ── Read Railway CLI config to get auth token + project IDs ─────────────────
function readRailwayConfig() {
  const configPath = path.join(os.homedir(), ".railway", "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`❌  Railway CLI config not found at ${configPath}`);
    console.error("    Run: railway login");
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.error(`❌  Could not parse ${configPath}: ${e.message}`);
    process.exit(1);
  }

  const token = cfg?.user?.accessToken || cfg?.user?.token;
  if (!token) {
    console.error(`❌  No auth token in ${configPath}. Run: railway login`);
    process.exit(1);
  }

  // Find the project linked to THIS repo (cwd).
  const projects = cfg?.projects || {};
  const repoProject = projects[root]
    ?? projects[root.replace(/\\/g, "/")]
    ?? Object.values(projects).find(p => p.projectPath === root || p.projectPath === root.replace(/\\/g, "/"));

  if (!repoProject) {
    console.error(`❌  No Railway project linked to ${root}.`);
    console.error("    Run: railway link");
    console.error(`    Configured projects in config.json: ${Object.keys(projects).join(", ") || "(none)"}`);
    process.exit(1);
  }

  return {
    token,
    projectId: repoProject.project,
    environmentId: repoProject.environment,
    serviceId: repoProject.service,
    projectName: repoProject.name,
  };
}

// ── GraphQL: upsert one variable on Railway ─────────────────────────────────
async function setVariable({ token, projectId, environmentId, serviceId }, name, value) {
  const query = `
    mutation VariableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;
  const variables = {
    input: {
      projectId,
      environmentId,
      serviceId,
      name,
      value,
    },
  };

  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.substring(0, 500)}`);
  }
  if (data?.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// ── Main ────────────────────────────────────────────────────────────────────
const cfg = readRailwayConfig();
console.log(`Project:     ${cfg.projectName} (${cfg.projectId})`);
console.log(`Environment: ${cfg.environmentId}`);
console.log(`Service:     ${cfg.serviceId}`);
console.log("");

let okCount = 0;
let failCount = 0;

for (const [key, filePath] of Object.entries(files)) {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  Skipping ${key} — file not found at ${filePath}`);
    continue;
  }

  const value = fs.readFileSync(filePath, "utf8").trim();
  console.log(`Updating ${key} (${value.length} chars)...`);

  try {
    await setVariable(cfg, key, value);
    console.log(`✅  ${key} updated\n`);
    okCount++;
  } catch (e) {
    console.error(`❌  ${key} failed: ${e.message}\n`);
    failCount++;
  }
}

console.log(`Done. ${okCount} updated, ${failCount} failed.`);
if (failCount > 0) {
  console.log("\nIf the auth token is expired, refresh it: railway login");
  process.exit(1);
}
console.log("Railway will redeploy automatically (~60s).");
