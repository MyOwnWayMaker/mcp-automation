# MCP Automation Server – Setup

## Google Workspace (Gmail, Calendar, Drive, Sheets)

### 1. Create a Google Cloud project & enable APIs

1. Go to https://console.cloud.google.com/
2. Create a new project (or select an existing one)
3. Enable these APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Sheets API
4. Go to **APIs & Services → Credentials**
5. Click **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Desktop app**
6. Download the JSON file → save it as `credentials.json` in this folder

### 2. Authenticate

```bash
cd ~/mcp-automation
npm run auth:google
```

Follow the link, approve access, paste the code. A `token.json` will be saved.

### 3. Test

```bash
node dist/index.js
```

You should see: `mcp-automation server running on stdio`

---

## iMessage

No setup needed — just make sure:
- You're on macOS
- The **Messages** app is open and signed into iMessage

The `imessage_send` tool uses AppleScript. On first use macOS may prompt you to grant Terminal/Claude automation access in **System Settings → Privacy & Security → Automation**.

---

## Adding to Claude Desktop

The server is already registered in `~/Library/Application Support/Claude/claude_desktop_config.json`.

**Restart Claude Desktop** for the MCP to load.

---

## Adding Custom Services

Use the `http_request` tool for any REST API:

```json
{
  "url": "https://api.example.com/endpoint",
  "method": "POST",
  "headers": { "Authorization": "Bearer YOUR_TOKEN", "Content-Type": "application/json" },
  "body": "{\"key\": \"value\"}"
}
```

For persistent custom integrations, add a new file in `src/tools/` and register it in `src/index.ts`.

---

## Endpoints

When deployed in HTTP mode (Railway), the server exposes a few public HTTP routes alongside the MCP `/sse` + `/messages` transport:

```
GET /now
  Returns current time + date in UTC + Pacific.
  Public, no auth. Used by Dispatch when its bash sandbox is unavailable.

GET /health
  Returns { status: "ok", tools: <count> }. Liveness probe.

GET /diagnose
  Reports which auth env vars are set and whether Google + Notary Gmail
  clients can reach the API. Public; values are presence-only, not secrets.

GET /qb-callback
  QuickBooks OAuth redirect target. Used during the initial auth flow only.
```

The deployed base URL is `https://mcp-automation-production.up.railway.app`.

