// Regression test for the XA push-layer clobber guard in
// scripts/update-railway-sessions.mjs (isPushableSession).
//
// History: the first cut of the guard required `cookies.length >= 20`. That
// false-positived on real-but-small authenticated sessions — the committed
// 4/22 xactanalysis_session.json reached the app yet had only 15 cookies, and
// the dead 2026-05-21 failed-OTP captures were ALSO 15. The reliable signal is
// a JSESSIONID scoped to the app host; count is noise. These tests lock that
// contract so the count floor can't creep back.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "scripts", "update-railway-sessions.mjs");

// Pull the ACTUAL guard out of the source so the test can't drift from it.
const src = fs.readFileSync(scriptPath, "utf8");
const start = src.indexOf("function isPushableSession");
const end = src.indexOf("// ── GraphQL");
assert.ok(start >= 0 && end > start, "could not locate isPushableSession in source");
const isPushableSession = new Function(
  src.slice(start, end).trim() + "\nreturn isPushableSession;",
)();

const blob = (cookies) => JSON.stringify({ cookies });
const r = (v) => isPushableSession("XACTANALYSIS_SESSION_JSON", v);

// Representative cookie sets (trimmed to the discriminating cookies; real
// captures carry more Incapsula/tracking cookies that don't affect the verdict).
const appJsessionid = { name: "JSESSIONID", domain: "www.xactanalysis.com" };
const ssoJsessionid = { name: "JSESSIONID", domain: "sso.verisk.com" };
const identityWall = [
  { name: "visid_incap_1392924", domain: ".verisk.com" },
  { name: "XSRF-TOKEN", domain: "identity.verisk.com" },
  { name: "idsrv.session", domain: "identity.verisk.com" },
  ssoJsessionid,
];

test("healthy session (app-host JSESSIONID present) is pushable", () => {
  assert.equal(r(blob([appJsessionid, ssoJsessionid])).ok, true);
});

test("REGRESSION: small (15-cookie) but authenticated session is pushable", () => {
  // Mirrors the committed 4/22 session: app JSESSIONID present, only ~15
  // cookies. The old `>= 20` floor wrongly blocked this.
  const fifteen = [appJsessionid, ...identityWall];
  while (fifteen.length < 15) fifteen.push({ name: `pad${fifteen.length}`, domain: ".xactanalysis.com" });
  const res = r(blob(fifteen));
  assert.equal(res.ok, true, `expected PUSH, got BLOCK: ${res.reason}`);
});

test("dead pre-auth capture (no app-host JSESSIONID) is blocked", () => {
  const res = r(blob(identityWall));
  assert.equal(res.ok, false);
  assert.match(res.reason, /no app-host JSESSIONID/);
});

test("malformed JSON is blocked", () => {
  assert.equal(r("{not json").ok, false);
});

test("empty / cookieless blob is blocked", () => {
  assert.equal(r(blob([])).ok, false);
});

test("non-XA keys are never gated", () => {
  assert.equal(isPushableSession("FILETRAC_SESSION_JSON", "{anything").ok, true);
});

// DOCUMENTED LIMITATION (not a bug to fix here): a pre-auth blob that picked up
// an app-host JSESSIONID on first contact would pass. It can't reach disk going
// forward because auth-xactanalysis.mjs (acfb0db) refuses to save a non-
// authenticated capture; closing it fully needs a stamped proof-of-auth marker.
test("documented limitation: pre-auth blob WITH app-host JSESSIONID passes", () => {
  assert.equal(r(blob([appJsessionid, ...identityWall])).ok, true);
});
