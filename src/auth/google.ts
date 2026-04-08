import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import readline from "readline";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH ?? `${MCP_DIR}/credentials.json`;
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ?? `${MCP_DIR}/token.json`;

function loadCredentials() {
  const credPath = path.resolve(CREDENTIALS_PATH);
  if (!fs.existsSync(credPath)) {
    throw new Error(
      `Google credentials file not found at: ${credPath}\n` +
      `Run: cp .env.example .env and set GOOGLE_CREDENTIALS_PATH`
    );
  }
  return JSON.parse(fs.readFileSync(credPath, "utf-8"));
}

export async function getGoogleAuthClient(): Promise<OAuth2Client> {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } =
    credentials.installed ?? credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const tokenPath = path.resolve(TOKEN_PATH);
  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    oAuth2Client.setCredentials(token);

    // Auto-refresh if expired
    oAuth2Client.on("tokens", (tokens) => {
      const existing = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
      fs.writeFileSync(tokenPath, JSON.stringify({ ...existing, ...tokens }));
    });

    return oAuth2Client;
  }

  throw new Error(
    "Google token not found. Run: npm run auth:google to authenticate."
  );
}

// Run this script directly to authorize: npm run auth:google
if (process.argv[1].endsWith("google.ts") || process.argv[1].endsWith("google.js")) {
  (async () => {
    const credentials = loadCredentials();
    const { client_secret, client_id, redirect_uris } =
      credentials.installed ?? credentials.web;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });

    console.log("\nAuthorize this app by visiting:\n");
    console.log(authUrl);
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question("Enter the code from that page here: ", async (code) => {
      rl.close();
      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(path.resolve(TOKEN_PATH), JSON.stringify(tokens, null, 2));
      console.log(`\nToken saved to ${TOKEN_PATH}`);
      console.log("You can now start the MCP server with: npm start");
    });
  })();
}
