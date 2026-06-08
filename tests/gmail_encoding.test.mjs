// Regression tests for RFC822 encoding / decoding in src/tools/gmail.ts.
//
// 2026-06-08 incident: gmailCreateDraft produced empty / truncated bodies for
// short replies. Root cause: encodeEmail's `.filter(Boolean)` stripped the
// `""` line that's supposed to be the blank-line header/body separator. Gmail
// then ate the first body line as a malformed header.
//
// These tests lock the encoding contract so the same regression never ships
// again. The tests use the EXPORTED encodeEmail + decodeDraftBody from the
// compiled dist/ so they cover the same code path the MCP tool calls.
//
// Run: npm run build && node --test tests/gmail_encoding.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { encodeEmail, decodeDraftBody } from "../dist/tools/gmail.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodeRaw(raw) {
  return Buffer.from(raw, "base64url").toString("utf-8");
}

function splitHeadersAndBody(rfc822) {
  const idx = rfc822.indexOf("\r\n\r\n");
  if (idx < 0) return { headers: rfc822, body: null };
  return { headers: rfc822.slice(0, idx), body: rfc822.slice(idx + 4) };
}

// Mimic the Gmail "payload" shape that gmail.users.drafts.get returns for a
// single-part text/plain message, so we can round-trip encodeEmail ->
// decodeDraftBody without hitting the live API.
function fakeGmailPayloadFromRaw(rawBase64Url) {
  const rfc822 = decodeRaw(rawBase64Url);
  const { body } = splitHeadersAndBody(rfc822);
  if (body === null) {
    // Headers-only or malformed — return a payload with no body.data, which is
    // how decodeDraftBody is expected to handle the empty case.
    return { body: {}, headers: [] };
  }
  return {
    headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
    body: { data: Buffer.from(body, "utf-8").toString("base64url") },
  };
}

// ─── Encoding integrity ──────────────────────────────────────────────────────

test("encodeEmail: produces a blank line separating headers from body", () => {
  const raw = encodeEmail({
    to: "diana@example.com",
    subject: "Re: 1226000034",
    body: "Received. And will do, thank you. I'll get this back over today.\n\nHakiel",
  });
  const rfc822 = decodeRaw(raw);
  // The header/body separator MUST be present and use CRLF.
  assert.ok(
    rfc822.includes("\r\n\r\n"),
    `encoded message is missing CRLF header/body separator. Raw:\n${rfc822}`
  );
});

test("encodeEmail: blank-line separator sits immediately after the last header", () => {
  const raw = encodeEmail({
    to: "diana@example.com",
    subject: "Re: 1226000034",
    body: "Body starts here.",
  });
  const rfc822 = decodeRaw(raw);
  const { headers, body } = splitHeadersAndBody(rfc822);
  assert.equal(body, "Body starts here.");
  // No malformed header line should be parsed as a header.
  assert.ok(!headers.includes("Body starts here"), "body bled into headers");
});

test("encodeEmail: round-trip preserves a multi-line body byte-for-byte", () => {
  const body = "Received. And will do, thank you. I'll get this back over today.\n\nHakiel";
  const raw = encodeEmail({
    to: "diana@example.com",
    subject: "Re: 1226000034",
    body,
  });
  const payload = fakeGmailPayloadFromRaw(raw);
  const decoded = decodeDraftBody(payload);
  assert.equal(decoded, body);
});

test("encodeEmail: round-trip preserves a single-line body (no trailing newline)", () => {
  const body = "Received. And will do, thank you. I'll get this back over today. Hakiel";
  const raw = encodeEmail({
    to: "diana@example.com",
    subject: "Re: 1226000034",
    body,
  });
  const decoded = decodeDraftBody(fakeGmailPayloadFromRaw(raw));
  assert.equal(decoded, body);
});

test("encodeEmail: round-trip preserves a body whose first line has no colon (regression for 2026-06-08)", () => {
  // This is the exact failure mode from the incident — first line is plain
  // English with no `Header: value` shape. Without the blank-line separator,
  // Gmail discarded it as a malformed header and only "Hakiel" survived.
  const body = "Received. And will do, thank you. I'll get this back over today.\n\nHakiel";
  const raw = encodeEmail({ to: "diana@example.com", subject: "Re: 1226000034", body });
  const decoded = decodeDraftBody(fakeGmailPayloadFromRaw(raw));
  assert.equal(decoded, body);
  assert.ok(decoded.startsWith("Received."), "first body line was lost");
});

test("encodeEmail: round-trip preserves a body whose first line LOOKS like a header (`X: y`)", () => {
  // Adversarial: a body that begins with a colon-shaped line could be mistaken
  // for a header by a parser if the blank-line separator is missing. With the
  // separator present, the parser must treat it as body.
  const body = "Note: this is the body, not a header.\n\nHakiel";
  const raw = encodeEmail({ to: "diana@example.com", subject: "Re: 1226000034", body });
  const decoded = decodeDraftBody(fakeGmailPayloadFromRaw(raw));
  assert.equal(decoded, body);
});

test("encodeEmail: optional Cc/Bcc/From appear in headers when provided, absent when omitted", () => {
  const withAll = decodeRaw(encodeEmail({
    to: "a@x.com", subject: "s", body: "b",
    from: "Hakiel <h@erseville.com>", cc: "c@x.com", bcc: "b@x.com",
  }));
  assert.ok(withAll.includes("From: Hakiel <h@erseville.com>"));
  assert.ok(withAll.includes("Cc: c@x.com"));
  assert.ok(withAll.includes("Bcc: b@x.com"));

  const minimal = decodeRaw(encodeEmail({ to: "a@x.com", subject: "s", body: "b" }));
  assert.ok(!minimal.includes("From:"));
  assert.ok(!minimal.includes("Cc:"));
  assert.ok(!minimal.includes("Bcc:"));
});

test("encodeEmail: In-Reply-To / References added together when replyToMessageId is set", () => {
  const raw = encodeEmail({
    to: "a@x.com", subject: "Re: thread", body: "thanks",
    replyToMessageId: "<abc@mail.gmail.com>",
  });
  const rfc822 = decodeRaw(raw);
  assert.ok(rfc822.includes("In-Reply-To: <abc@mail.gmail.com>"));
  assert.ok(rfc822.includes("References: <abc@mail.gmail.com>"));
});

test("encodeEmail: extraHeaders flow through verbatim", () => {
  const raw = encodeEmail({
    to: "a@x.com", subject: "s", body: "b",
    extraHeaders: { "X-Mcp-Scheduled-Send": "2027-01-01T00:00:00Z" },
  });
  const rfc822 = decodeRaw(raw);
  assert.ok(rfc822.includes("X-Mcp-Scheduled-Send: 2027-01-01T00:00:00Z"));
});

test("encodeEmail: uses CRLF line endings throughout the header block", () => {
  const raw = encodeEmail({ to: "a@x.com", subject: "s", body: "b" });
  const rfc822 = decodeRaw(raw);
  const { headers } = splitHeadersAndBody(rfc822);
  // Every header line must end with \r\n in canonical RFC822.
  const lines = headers.split("\r\n");
  for (const line of lines) {
    assert.ok(!line.includes("\n"), `header line contains bare \\n: ${JSON.stringify(line)}`);
  }
});

// ─── Body fuzz: shapes that have bitten us or could bite us ─────────────────

const FUZZ_BODIES = [
  ["empty string",                ""],
  ["single space",                " "],
  ["single newline",              "\n"],
  ["leading blank line + content","\n\nactual body"],
  ["trailing newline only",       "line\n"],
  ["windows line endings",        "line one\r\nline two\r\n"],
  ["mixed line endings",          "a\nb\r\nc\n\rd"],
  ["unicode + emoji",             "Héllo 👋 — 你好"],
  ["very long line",              "x".repeat(5000)],
  ["colon-leading first line",    "Subject: not really a subject\n\nbody"],
  ["dotstuff dot at start",       ".test\n..test"],
  ["html-looking body",           "<p>hi</p>"],
];

for (const [label, body] of FUZZ_BODIES) {
  test(`encodeEmail fuzz: ${label}`, () => {
    const raw = encodeEmail({ to: "a@x.com", subject: "s", body });
    const rfc822 = decodeRaw(raw);
    assert.ok(rfc822.includes("\r\n\r\n"), `${label}: missing separator`);
    const decoded = decodeDraftBody(fakeGmailPayloadFromRaw(raw));
    assert.equal(decoded, body, `${label}: round-trip lost data`);
  });
}

// ─── decodeDraftBody behavior ────────────────────────────────────────────────

test("decodeDraftBody: empty / null payload -> empty string (not a crash)", () => {
  assert.equal(decodeDraftBody(null), "");
  assert.equal(decodeDraftBody(undefined), "");
  assert.equal(decodeDraftBody({}), "");
});

test("decodeDraftBody: multipart/alternative picks text/plain part", () => {
  const text = "plain body";
  const payload = {
    parts: [
      { mimeType: "text/html",  body: { data: Buffer.from("<p>html</p>").toString("base64url") } },
      { mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } },
    ],
  };
  assert.equal(decodeDraftBody(payload), text);
});
