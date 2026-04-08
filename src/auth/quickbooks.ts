import "dotenv/config";
import fs from "fs";
import http from "http";
import { URL } from "url";

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const TOKEN_PATH = `${MCP_DIR}/quickbooks_token.json`;
const REDIRECT_URI = "http://localhost:8085/callback";
const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPES = "com.intuit.quickbooks.accounting";

function getCredentials() {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be set in .env");
  }
  return { clientId, clientSecret };
}

function loadToken() {
  // Support token stored as env var (for Railway)
  if (process.env.QUICKBOOKS_TOKEN_JSON) {
    return JSON.parse(process.env.QUICKBOOKS_TOKEN_JSON);
  }
  if (fs.existsSync(TOKEN_PATH)) {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  }
  return null;
}

function saveToken(token: object) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshAccessToken(refreshToken: string): Promise<any> {
  const { clientId, clientSecret } = getCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

export async function getQuickBooksToken(): Promise<{ access_token: string; realm_id: string }> {
  const token = loadToken();
  if (!token) throw new Error("QuickBooks not authenticated. Run: npm run auth:quickbooks");

  // Refresh if expired (with 5 min buffer)
  if (Date.now() > token.expiry_date - 300_000) {
    const refreshed = await refreshAccessToken(token.refresh_token);
    const updated = {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? token.refresh_token,
      expiry_date: Date.now() + refreshed.expires_in * 1000,
    };
    if (!process.env.QUICKBOOKS_TOKEN_JSON) saveToken(updated);
    return { access_token: updated.access_token, realm_id: updated.realm_id };
  }

  return { access_token: token.access_token, realm_id: token.realm_id };
}

// Run this script directly to authorize: npm run auth:quickbooks
if (process.argv[1].endsWith("quickbooks.ts") || process.argv[1].endsWith("quickbooks.js")) {
  (async () => {
    const { clientId } = getCredentials();

    const authUrl = `${AUTH_BASE}?client_id=${clientId}&response_type=code&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=claude_mcp`;

    console.log("\nOpen this URL in your browser to authorize QuickBooks:\n");
    console.log(authUrl);
    console.log("\nWaiting for callback on http://localhost:8085...\n");

    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/callback")) return;

      const params = new URL(req.url, "http://localhost:8085").searchParams;
      const code = params.get("code");
      const realmId = params.get("realmId");

      if (!code || !realmId) {
        res.end("Missing code or realmId. Try again.");
        return;
      }

      try {
        const { clientId, clientSecret } = getCredentials();
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

        const tokenRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
          }),
        });

        const tokens = await tokenRes.json() as any;
        const tokenData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: Date.now() + tokens.expires_in * 1000,
          realm_id: realmId,
        };

        saveToken(tokenData);
        res.end("<h2>QuickBooks connected! You can close this tab.</h2>");
        console.log(`\nToken saved to ${TOKEN_PATH}`);
        console.log("You can now use QuickBooks tools in the MCP server.");
        server.close();
      } catch (err) {
        res.end(`Error: ${(err as Error).message}`);
        server.close();
      }
    });

    server.listen(8085);
  })();
}
