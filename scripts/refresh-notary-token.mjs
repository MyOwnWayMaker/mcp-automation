// Two-step OAuth refresh for the notary Gmail (drupenterprise1@gmail.com).
// Run via `railway run` so GOOGLE_CREDENTIALS_JSON is injected.
//
// Usage:
//   step 1 (print URL):       node scripts/refresh-notary-token.mjs
//   step 2 (exchange code):   node scripts/refresh-notary-token.mjs <code-from-google>
//
// After step 2 prints the token JSON, push it to Railway as
// GOOGLE_NOTARY_TOKEN_JSON.

import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const credsRaw = process.env.GOOGLE_CREDENTIALS_JSON;
if (!credsRaw) {
  console.error("GOOGLE_CREDENTIALS_JSON not set. Run via: railway run node scripts/refresh-notary-token.mjs");
  process.exit(1);
}
const credentials = JSON.parse(credsRaw);
const { client_secret, client_id, redirect_uris } = credentials.installed ?? credentials.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const code = process.argv[2];

if (!code) {
  // Step 1: print the auth URL.
  const url = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent select_account", // forces refresh_token + account picker
  });
  console.log("\nredirect_uri Google will use:", redirect_uris[0]);
  console.log("\n=== AUTH URL ===");
  console.log(url);
  console.log("\nOpen on your phone, sign in as drupenterprise1@gmail.com, then either:");
  console.log("  - if Google shows a code on the page, paste it back to Code");
  console.log("  - if Google redirects to a URL, copy the value of `code=` from the URL");
} else {
  // Step 2: exchange the code for a token.
  try {
    const { tokens } = await auth.getToken(code);
    console.log("\n=== TOKEN JSON (copy this, push to Railway as GOOGLE_NOTARY_TOKEN_JSON) ===");
    console.log(JSON.stringify(tokens));
    console.log("\nrefresh_token present:", Boolean(tokens.refresh_token));
    if (!tokens.refresh_token) {
      console.warn("WARNING: no refresh_token in response. Re-run step 1 - this can happen if Google");
      console.warn("had already issued one for this account+app. Revoke at");
      console.warn("https://myaccount.google.com/permissions and try again.");
    }
  } catch (e) {
    console.error("Token exchange failed:", e.message);
    if (e.response?.data) console.error("Body:", JSON.stringify(e.response.data));
    process.exit(2);
  }
}
