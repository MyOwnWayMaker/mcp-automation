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
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/tasks",
];

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH ?? `${MCP_DIR}/credentials.json`;
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ?? `${MCP_DIR}/token.json`;

function loadCredentials() {
  // Support credentials stored as env var (for Railway/cloud deployment)
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  const credPath = path.resolve(CREDENTIALS_PATH);
  if (!fs.existsSync(credPath)) {
    throw new Error(`Google credentials not found. Set GOOGLE_CREDENTIALS_JSON env var.`);
  }
  return JSON.parse(fs.readFileSync(credPath, "utf-8"));
}

function loadToken() {
  // Support token stored as env var (for Railway/cloud deployment)
  if (process.env.GOOGLE_TOKEN_JSON) {
    return JSON.parse(process.env.GOOGLE_TOKEN_JSON);
  }
  const tokenPath = path.resolve(TOKEN_PATH);
  if (fs.existsSync(tokenPath)) {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  }
  return null;
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

  const token = loadToken();
  if (!token) {
    throw new Error("Google token not found. Run: npm run auth:google to authenticate.");
  }

  oAuth2Client.setCredentials(token);

  // Always refresh if the access token is expired or about to expire (within 60s).
  // The refresh_token is permanent — this means Railway never needs a manual token update.
  const isExpired = !token.access_token || (token.expiry_date && token.expiry_date < Date.now() + 60000);
  if (isExpired && token.refresh_token) {
    try {
      const { credentials: fresh } = await oAuth2Client.refreshAccessToken();
      oAuth2Client.setCredentials(fresh);
      // Persist locally so the file stays fresh too
      if (!process.env.GOOGLE_TOKEN_JSON) {
        const tokenPath = path.resolve(TOKEN_PATH);
        const existing = fs.existsSync(tokenPath)
          ? JSON.parse(fs.readFileSync(tokenPath, "utf-8"))
          : {};
        fs.writeFileSync(tokenPath, JSON.stringify({ ...existing, ...fresh }));
      }
    } catch {
      // Refresh failed — proceed anyway, googleapis may still recover
    }
  }

  // Also save any future token refreshes locally
  if (!process.env.GOOGLE_TOKEN_JSON) {
    const tokenPath = path.resolve(TOKEN_PATH);
    oAuth2Client.on("tokens", (tokens) => {
      if (fs.existsSync(tokenPath)) {
        const existing = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
        fs.writeFileSync(tokenPath, JSON.stringify({ ...existing, ...tokens }));
      }
    });
  }

  return oAuth2Client;
}

// Run this script directly to authorize: npm run auth:google
if (process.argv[1]?.endsWith("google.ts") || process.argv[1]?.endsWith("google.js")) {
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

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Enter the code from that page here: ", async (code) => {
      rl.close();
      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(path.resolve(TOKEN_PATH), JSON.stringify(tokens, null, 2));
      console.log(`\nToken saved to ${TOKEN_PATH}`);
      console.log("You can now start the MCP server with: npm start");
    });
  })();
}
