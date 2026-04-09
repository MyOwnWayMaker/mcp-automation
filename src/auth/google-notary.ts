import "dotenv/config";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import readline from "readline";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const CREDENTIALS_PATH = `${MCP_DIR}/credentials.json`;
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH_NOTARY ?? `${MCP_DIR}/token_notary.json`;

function loadCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`credentials.json not found at ${CREDENTIALS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
}

export async function getNotaryGmailClient(): Promise<OAuth2Client> {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } =
    credentials.installed ?? credentials.web;

  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Support env var for Railway
  if (process.env.GOOGLE_NOTARY_TOKEN_JSON) {
    auth.setCredentials(JSON.parse(process.env.GOOGLE_NOTARY_TOKEN_JSON));
    return auth;
  }

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error("Notary Gmail not authenticated. Run: npm run auth:notary-gmail");
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  auth.setCredentials(token);

  auth.on("tokens", (tokens) => {
    const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }));
  });

  return auth;
}

// Run to authenticate: npm run auth:notary-gmail
if (process.argv[1]?.endsWith("google-notary.ts") || process.argv[1]?.endsWith("google-notary.js")) {
  (async () => {
    const credentials = loadCredentials();
    const { client_secret, client_id, redirect_uris } =
      credentials.installed ?? credentials.web;

    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const authUrl = auth.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "select_account",
    });

    console.log("\nOpen this URL and sign in with drupenterprise1@gmail.com:\n");
    console.log(authUrl);
    console.log();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Enter the code from that page here: ", async (code) => {
      rl.close();
      const { tokens } = await auth.getToken(code);
      fs.writeFileSync(path.resolve(TOKEN_PATH), JSON.stringify(tokens, null, 2));
      console.log(`\nNotary Gmail token saved to ${TOKEN_PATH}`);
    });
  })();
}
