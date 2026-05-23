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
  // Voice: prefer the compacted file (Railway 32KB env-var cap); fall back
  // to the raw session if compact wasn't generated. Missing files are
  // skipped by the loop below, so this is safe even on a fresh checkout.
  VOICE_SESSION_JSON:        fs.existsSync(path.join(root, "voice_session.compact.json"))
                               ? path.join(root, "voice_session.compact.json")
                               : path.join(root, "voice_session.json"),
};

// ── Resolve auth token + project IDs ────────────────────────────────────────
// Two auth sources, in priority order:
//   1. RAILWAY_API_TOKEN env var (Personal Access Token from
//      https://railway.com/account/tokens) — preferred, doesn't expire,
//      authorized for GraphQL API calls.
//   2. ~/.railway/config.json accessToken (the OAuth session token Railway
//      CLI caches) — works for the CLI but NOT for direct GraphQL calls;
//      kept here so we can read project IDs from the config even when the
//      env var is set, and as a fallback that surfaces a clear error message
//      if the user hasn't generated a PAT yet.
function readRailwayConfig() {
  const configPath = path.join(os.homedir(), ".railway", "config.json");

  let cfg = null;
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      console.error(`⚠️  Could not parse ${configPath}: ${e.message}`);
    }
  }

  // Prefer PAT from env. The CLI's accessToken (OAuth session) gets
  // "Not Authorized" from variableUpsert even though the CLI itself works
  // with it — the CLI hits a different endpoint behind the scenes.
  const envToken = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  const cfgToken = cfg?.user?.accessToken || cfg?.user?.token;
  const token = envToken || cfgToken;
  const tokenSource = envToken ? "RAILWAY_API_TOKEN env var (PAT)" : "Railway CLI config (OAuth)";

  if (!token) {
    console.error("❌  No Railway auth token found.");
    console.error("    Two options:");
    console.error("    (1) Generate a Personal Access Token at https://railway.com/account/tokens");
    console.error("        then set: $env:RAILWAY_API_TOKEN=\"<token>\"  (PowerShell)");
    console.error("    (2) Run `railway login` so the CLI caches credentials");
    process.exit(1);
  }

  // Find the project linked to THIS repo from the CLI config (we still need
  // projectId/environmentId/serviceId regardless of token source).
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
    tokenSource,
    projectId: repoProject.project,
    environmentId: repoProject.environment,
    serviceId: repoProject.service,
    projectName: repoProject.name,
  };
}

// ── Push-layer clobber guard for XA ─────────────────────────────────────────
// Refuse to push a XACTANALYSIS_SESSION_JSON blob that isn't an AUTHENTICATED
// app session. A failed-OTP / MFA-wall capture leaves only identity.verisk +
// SSO + Incapsula cookies and no app-host JSESSIONID; pushing that overwrites a
// good Railway session with a dead one — the proven cause of the 2026-05-21
// early expiry (cron logs pushed 14KB then 4.9KB pre-auth blobs at 08:49/08:55).
//
// auth-xactanalysis.mjs already gates its own push (commit acfb0db), but this
// guard sits at the PUSH layer so it protects EVERY caller — manual
// `node scripts/update-railway-sessions.mjs` runs, future auth scripts, a
// stale local xactanalysis_session.json — not just that one code path.
//
// DISCRIMINATOR: a JSESSIONID scoped to the app host (www.xactanalysis.com).
// You only receive that after the app serves an authenticated page; a capture
// stuck at the identity.verisk MFA wall has none. Cookie *count* is NOT usable
// — a real authenticated session can be as small as 15 cookies (verified
// against the committed 4/22 session) and the dead 2026-05-21 captures were
// ALSO 15. An earlier `cookies.length >= 20` floor false-positived on small-
// but-valid sessions; tests/xa_push_guard.test.mjs locks the contract.
//
// Known limitation: a pre-auth capture that picked up an app-host JSESSIONID on
// first contact (before the MFA wall) would pass this check. That can't reach
// disk going forward — auth-xactanalysis.mjs's acfb0db gate refuses to SAVE any
// non-authenticated capture — so it's a legacy-only edge. Closing it fully would
// need the auth script to stamp a proof-of-auth marker (see deliverable notes).
// Other session vars are left as-is (their shapes aren't validated here).
function isPushableSession(key, value) {
  if (key !== "XACTANALYSIS_SESSION_JSON") return { ok: true };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return { ok: false, reason: `not valid JSON (${e.message})` };
  }
  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  const hasAppSession = cookies.some(
    (c) => c && c.name === "JSESSIONID" && typeof c.domain === "string" && c.domain.includes("xactanalysis.com"),
  );
  if (hasAppSession) return { ok: true };
  return {
    ok: false,
    reason: `no app-host JSESSIONID (cookies=${cookies.length}) — looks like a ` +
      `pre-auth / failed-OTP capture; refusing to clobber a good Railway session`,
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
console.log(`Auth:        ${cfg.tokenSource}`);
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

  const guard = isPushableSession(key, value);
  if (!guard.ok) {
    console.error(`⛔  ${key} NOT pushed — ${guard.reason}.`);
    console.error(`    Source file: ${filePath}`);
    console.error(`    Re-run a successful auth (reach the dashboard) before pushing.\n`);
    failCount++;
    continue;
  }

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
  console.log("\nIf you saw 'Not Authorized' errors, the Railway CLI's cached OAuth");
  console.log("token doesn't have GraphQL API scope. Generate a Personal Access Token:");
  console.log("  1. https://railway.com/account/tokens");
  console.log("  2. Create token, copy it");
  console.log("  3. PowerShell: [Environment]::SetEnvironmentVariable(\"RAILWAY_API_TOKEN\", \"<token>\", \"User\")");
  console.log("  4. Close + reopen terminal, re-run this script");
  process.exit(1);
}
console.log("Railway will redeploy automatically (~60s).");
