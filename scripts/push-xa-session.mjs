/**
 * Push ONLY XACTANALYSIS_SESSION_JSON to Railway.
 *
 * Deliberately single-var: the multi-var update-railway-sessions.mjs reads
 * filetrac/voice/notary local files too and can overwrite fresher Railway
 * sessions with stale local ones (the documented Voice/Notary/FileTrac clobber).
 * The scheduled XA re-auth runs the auth script with SKIP_RAILWAY_PUSH=1 and
 * then calls THIS to push the one var it actually refreshed.
 *
 * Auth: RAILWAY_API_TOKEN (PAT) — works for the GraphQL variableUpsert mutation.
 * Refuses to push a non-authenticated session (must carry cookies + the Verisk
 * device-trust 'DT' cookie).
 *
 *   node scripts/push-xa-session.mjs            # uses ./xactanalysis_session.json
 *   XA_SESSION_FILE=/path node scripts/push-xa-session.mjs
 */
import fs from "fs";
import path from "path";

const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
if (!token) {
  console.error("❌ No RAILWAY_API_TOKEN / RAILWAY_TOKEN in env.");
  process.exit(2);
}

// Railway: project vibrant-wisdom / service mcp-automation / env production.
const projectId     = process.env.RAILWAY_PROJECT_ID     || "9dc2f475-47e2-4782-a87f-56e3ca34a860";
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || "98879b13-bced-4932-b2d5-44be8df57f78";
const serviceId     = process.env.RAILWAY_SERVICE_ID     || "3b2de67b-6cf6-446e-93f9-2b00eaf1da6f";

const sessionFile = process.env.XA_SESSION_FILE
  || path.resolve(process.cwd(), "xactanalysis_session.json");
if (!fs.existsSync(sessionFile)) {
  console.error(`❌ Session file not found: ${sessionFile}`);
  process.exit(2);
}
const value = fs.readFileSync(sessionFile, "utf8").trim();

// Guard: only push a genuinely authenticated session.
let parsed;
try { parsed = JSON.parse(value); } catch { console.error("❌ Session file is not valid JSON."); process.exit(3); }
const cookieCount = parsed.cookies?.length ?? 0;
const hasDT = (parsed.cookies || []).some((c) => c.name === "DT" && /verisk/.test(c.domain));
if (cookieCount < 20) {
  console.error(`❌ Refusing to push: only ${cookieCount} cookies (looks pre-auth/dead).`);
  process.exit(3);
}
if (!hasDT) {
  // Not fatal — device-trust cookie may be absent on a non-remembered login —
  // but warn loudly, since a session without DT will need an OTP next time.
  console.warn("⚠️  No Verisk device-trust 'DT' cookie in this session (next re-auth may need an OTP).");
}

const query = `mutation VariableUpsert($input: VariableUpsertInput!){ variableUpsert(input:$input) }`;
const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    query,
    variables: { input: { projectId, environmentId, serviceId, name: "XACTANALYSIS_SESSION_JSON", value } },
  }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`❌ HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(4);
}
let data;
try { data = JSON.parse(text); } catch { data = null; }
if (data?.errors?.length) {
  console.error("❌ GraphQL error:", JSON.stringify(data.errors));
  process.exit(5);
}
console.log(`✅ Pushed XACTANALYSIS_SESSION_JSON only (${value.length} chars, ${cookieCount} cookies, DT=${hasDT}). Auto-redeploys ~60s.`);
