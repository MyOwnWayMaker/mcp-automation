// Regression tests for the strict-send guardrail (src/util/send_guardrail.ts).
// Closes the auto-reply gap that shipped un-reviewed mail on 2026-06-04/05:
// gmail_send_draft, notary_send_email, gmail_notary_reply_to_email were all
// unguarded — anything connected to the MCP could ship a draft without
// Hakiel's review. The shared helper enforces ONE rule across all four
// send tools.
//
// Run with: npm run build && node --test tests/send_guardrail.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRecipientDomains,
  allRecipientsInternal,
  checkSendGuardrail,
} from "../dist/util/send_guardrail.js";

const freshIso = () => new Date(Date.now() - 60_000).toISOString();   // 1 min ago — fresh
const staleIso = () => new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago — stale
const futureIso = () => new Date(Date.now() + 60_000).toISOString();  // 1 min ahead — invalid

// ── recipient parsing ───────────────────────────────────────────────────────

test("extractRecipientDomains: plain address", () => {
  assert.deepEqual(extractRecipientDomains("a@x.com"), ["x.com"]);
});

test("extractRecipientDomains: display-name + angle brackets", () => {
  assert.deepEqual(
    extractRecipientDomains('"Jane Doe" <jane@x.com>'),
    ["x.com"],
  );
});

test("extractRecipientDomains: comma-separated, multi-field", () => {
  assert.deepEqual(
    extractRecipientDomains("a@x.com, b@y.org", "c@z.io"),
    ["x.com", "y.org", "z.io"],
  );
});

test("extractRecipientDomains: empty / undefined fields drop cleanly", () => {
  assert.deepEqual(extractRecipientDomains(undefined, "", "a@x.com"), ["x.com"]);
});

// ── allRecipientsInternal ───────────────────────────────────────────────────

test("allRecipientsInternal: erseville.com only -> true", () => {
  assert.equal(allRecipientsInternal("hakiel@erseville.com"), true);
});

test("allRecipientsInternal: mixed internal+external -> false", () => {
  assert.equal(
    allRecipientsInternal("hakiel@erseville.com, jane@uscs-claims.com"),
    false,
  );
});

test("allRecipientsInternal: third-party only -> false", () => {
  assert.equal(allRecipientsInternal("jane@uscs-claims.com"), false);
});

test("allRecipientsInternal: no recipients -> false (cannot bypass on empty)", () => {
  assert.equal(allRecipientsInternal(""), false);
  assert.equal(allRecipientsInternal(undefined), false);
});

// ── checkSendGuardrail: the actual gate ─────────────────────────────────────

test("guardrail: internal-only recipient bypasses with NO approval needed", () => {
  const r = checkSendGuardrail({ tool: "gmail_send_draft", to: "hakiel@erseville.com" });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.path, "internal_only");
});

test("guardrail: third-party + NO approval -> refused", () => {
  const r = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: "jane@uscs-claims.com",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /REFUSED/);
  assert.match(r.reason, /jane@uscs-claims\.com/);
});

test("guardrail: third-party + fresh approval but force_send=false -> refused", () => {
  const r = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: "jane@uscs-claims.com",
    approved_at_iso_timestamp: freshIso(),
    force_send: false,
  });
  assert.equal(r.ok, false);
});

test("guardrail: third-party + force_send=true but stale approval -> refused", () => {
  const r = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: "jane@uscs-claims.com",
    approved_at_iso_timestamp: staleIso(),
    force_send: true,
  });
  assert.equal(r.ok, false);
});

test("guardrail: third-party + force_send=true + fresh approval -> allowed", () => {
  const r = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: "jane@uscs-claims.com",
    approved_at_iso_timestamp: freshIso(),
    force_send: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.path, "approved_override");
});

test("guardrail: future-dated approval (ageMs < 0) -> refused", () => {
  // Don't let a caller post-date the approval to satisfy the freshness check.
  const r = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: "jane@uscs-claims.com",
    approved_at_iso_timestamp: futureIso(),
    force_send: true,
  });
  assert.equal(r.ok, false);
});

test("guardrail: malformed approval timestamp -> refused", () => {
  const r = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: "jane@uscs-claims.com",
    approved_at_iso_timestamp: "not-a-date",
    force_send: true,
  });
  assert.equal(r.ok, false);
});

test("guardrail: cc-only third-party still triggers refusal (no to)", () => {
  const r = checkSendGuardrail({
    tool: "notary_send_email",
    to: "hakiel@erseville.com",
    cc: "jane@uscs-claims.com",
  });
  assert.equal(r.ok, false);
});

test("guardrail: refusal message includes the calling tool name", () => {
  const r = checkSendGuardrail({
    tool: "gmail_notary_reply_to_email",
    to: "jane@uscs-claims.com",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /gmail_notary_reply_to_email/);
});

test("guardrail: unparseable 'to' is NOT treated as internal-only", () => {
  // No domain extracted -> not internal-only -> requires approval. Empty
  // recipient lists must never accidentally satisfy the bypass.
  const r = checkSendGuardrail({ tool: "gmail_send_draft", to: "" });
  assert.equal(r.ok, false);
});
