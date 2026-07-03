#!/usr/bin/env node
// fetch-railway-var.mjs <VAR_NAME>
//
// Prints the value of a single Railway service variable to stdout (and nothing
// else), so a cron wrapper can hydrate its environment from Railway — the single
// source of truth for sessions that a re-auth pushes there:
//
//   export FILETRAC_SESSION_JSON="$(node scripts/fetch-railway-var.mjs FILETRAC_SESSION_JSON)"
//
// The local claim-pipeline cron has no FileTrac session of its own; this keeps
// it in sync with whatever the 5-day FileTrac re-auth last pushed to Railway,
// so the local job never runs on a stale snapshot.
//
// Uses RAILWAY_API_TOKEN (GraphQL `variables` query — works with the GraphQL-
// scoped PAT even though `railway whoami` 401s). Project/env/service IDs match
// scripts/push-xa-session.mjs and are overridable via env.

const name = process.argv[2];
if (!name) { console.error("usage: fetch-railway-var.mjs <VAR_NAME>"); process.exit(2); }

const token = process.env.RAILWAY_API_TOKEN;
if (!token) { console.error("RAILWAY_API_TOKEN not set"); process.exit(2); }

const projectId     = process.env.RAILWAY_PROJECT_ID     || "9dc2f475-47e2-4782-a87f-56e3ca34a860";
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || "98879b13-bced-4932-b2d5-44be8df57f78";
const serviceId     = process.env.RAILWAY_SERVICE_ID     || "3b2de67b-6cf6-446e-93f9-2b00eaf1da6f";

const query = `query v($p:String!,$e:String!,$s:String!){ variables(projectId:$p,environmentId:$e,serviceId:$s) }`;

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ query, variables: { p: projectId, e: environmentId, s: serviceId } }),
});

let json;
try { json = await res.json(); }
catch { console.error(`Railway response not JSON (HTTP ${res.status})`); process.exit(1); }

if (json.errors) { console.error("Railway GraphQL error:", JSON.stringify(json.errors).slice(0, 200)); process.exit(1); }

const val = json.data?.variables?.[name];
if (val == null) { console.error(`var ${name} not found on service`); process.exit(1); }

process.stdout.write(val);
