// One-shot Railway variable upsert for a single env var.
// Usage: node scripts/push-railway-var.mjs <NAME> <path-to-file>
// Reads <path-to-file> as the value (UTF-8). Auth via RAILWAY_API_TOKEN
// or ~/.railway/config.json (same precedence as update-railway-sessions.mjs).

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const [, , name, filePath] = process.argv;
if (!name || !filePath) {
  console.error("Usage: node scripts/push-railway-var.mjs <NAME> <path-to-file>");
  process.exit(1);
}

const value = fs.readFileSync(filePath, "utf8").trim();
console.log(`Pushing ${name} (${value.length} chars) from ${filePath}`);

const configPath = path.join(os.homedir(), ".railway", "config.json");
const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : null;
const envToken = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
const cfgToken = cfg?.user?.accessToken || cfg?.user?.token;
const token = envToken || cfgToken;
if (!token) {
  console.error("No Railway auth token. Set RAILWAY_API_TOKEN or run `railway login`.");
  process.exit(1);
}

const projects = cfg?.projects || {};
const repoProject = projects[root]
  ?? projects[root.replace(/\\/g, "/")]
  ?? Object.values(projects).find((p) => p.projectPath === root || p.projectPath === root.replace(/\\/g, "/"));
if (!repoProject) {
  console.error(`No Railway project linked at ${root}. Run: railway link`);
  process.exit(1);
}

const query = `mutation VariableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`;
const variables = {
  input: {
    projectId: repoProject.project,
    environmentId: repoProject.environment,
    serviceId: repoProject.service,
    name,
    value,
  },
};

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query, variables }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${text.substring(0, 500)}`);
  process.exit(1);
}
const data = JSON.parse(text);
if (data.errors?.length) {
  console.error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  process.exit(1);
}
console.log(`OK. Railway will redeploy in ~60s.`);
