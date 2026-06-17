import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { getGoogleAuthClient } from "../auth/google.js";
import { checkSendGuardrail, allRecipientsInternal as guardrailAllInternal } from "../util/send_guardrail.js";
import { appendToSchedule, type ScheduledSend } from "./scheduled_send.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getGmail() {
  const auth = await getGoogleAuthClient();
  return google.gmail({ version: "v1", auth });
}

// Exported for use by watchers that need to create drafts / fetch signature
// without going through the MCP tool surface.
export async function getGmailClient() {
  return getGmail();
}

function makeTextContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function encodeEmail(params: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  replyToMessageId?: string;
  threadId?: string;
  extraHeaders?: Record<string, string>;
}): string {
  const lines = [
    `To: ${params.to}`,
    params.from ? `From: ${params.from}` : null,
    params.cc ? `Cc: ${params.cc}` : null,
    params.bcc ? `Bcc: ${params.bcc}` : null,
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    params.replyToMessageId ? `In-Reply-To: ${params.replyToMessageId}` : null,
    params.replyToMessageId ? `References: ${params.replyToMessageId}` : null,
    ...Object.entries(params.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
    "",
    params.body,
  ]
    .filter((x): x is string => x !== null)
    .join("\r\n");

  return Buffer.from(lines).toString("base64url");
}

// Strict-send domain check + approval logic now live in src/util/send_guardrail.ts
// (shared with the notary send tools). Re-exported alias for back-compat
// callers in this file.
const allRecipientsInternal = guardrailAllInternal;

/**
 * Send an email via Gmail. To prevent another direct-send bypass (the Paul
 * Kuhr incident on 2026-05-19 where a third-party email shipped without
 * draft review), this tool enforces a strict-send guardrail when ANY
 * recipient is on an external domain:
 *
 *   - Either pass `draft_id` (preferred) — sends an existing draft Hakiel
 *     reviewed; the tool internally promotes to gmail_send_draft semantics.
 *   - Or pass `approved_at_iso_timestamp` (ISO-8601 string, must be within
 *     the last 15 min so a stale approval can't be replayed) AND
 *     `force_send: true` as an explicit override. Used for time-sensitive
 *     sends where Hakiel approved verbally / via ntfy.
 *
 * Sends with ALL recipients on internal domains (GMAIL_INTERNAL_DOMAINS env
 * var, default "erseville.com") bypass the check — internal sends are
 * low-risk and the friction isn't worth it.
 */
export async function gmailSendEmail(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  draft_id?: string;
  approved_at_iso_timestamp?: string;
  force_send?: boolean;
}): Promise<CallToolResult> {
  // If a draft_id is given, route through send-draft semantics — that's the
  // happy path (reviewed draft → ship).
  if (args.draft_id) {
    return gmailSendDraft({ draft_id: args.draft_id });
  }

  // Strict-send guardrail for third-party recipients.
  const decision = checkSendGuardrail({
    tool: "gmail_send_email",
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    approved_at_iso_timestamp: args.approved_at_iso_timestamp,
    force_send: args.force_send,
  });
  if (!decision.ok) return makeTextContent(decision.reason);

  const gmail = await getGmail();
  const raw = encodeEmail(args);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return makeTextContent(
    `✅ Email sent. Message ID: ${res.data.id}\n` +
    `Path: ${decision.path === "internal_only" ? "internal-only (guardrail skipped)" : "force_send with fresh approval"}`
  );
}

/**
 * Create a Gmail DRAFT instead of sending. Same MIME path as gmailSendEmail
 * (identical base64url-encoded RFC822 message) but wrapped in a Draft
 * resource and POSTed to users.drafts.create — Hakiel reviews + sends from
 * his Gmail compose window. Uses the same OAuth client/scope as the send
 * tool (gmail.compose covers drafts.* — verified: drafts.create succeeds).
 * Note: attachments are not supported (neither is gmail_send_email today).
 *
 * Snapshot-approval (Hakiel rule 2026-05-18): after creating the draft we
 * READ IT BACK via users.drafts.get and push that exact stored content to
 * Hakiel's phone (ntfy) so he can confirm the composed email actually
 * contains what it should before he sends — third-party drafts have
 * sometimes come out missing content for unclear reasons. The tool response
 * also carries the verified snapshot. We snapshot the SERVER-STORED draft,
 * not our inputs, so a silent encode/store drop is caught.
 */
export function decodeDraftBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  if (Array.isArray(payload.parts)) {
    const plain = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain?.body?.data) return Buffer.from(plain.body.data, "base64url").toString("utf-8");
    return payload.parts.map(decodeDraftBody).filter(Boolean).join("\n");
  }
  return "";
}

// Short, lock-screen-friendly recipient label: display name if the To has
// one ("Jane Doe <j@x.com>" -> "Jane Doe"), else the local-part ("j@x.com"
// -> "j"). First recipient only.
function shortRecipient(to: string): string {
  const first = (to || "").split(",")[0].trim();
  const named = first.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (named) return named[1].trim();
  const at = first.indexOf("@");
  return (at > 0 ? first.slice(0, at) : first) || "recipient";
}

/**
 * Push the FULL draft to Hakiel's phone so he can approve/edit/drop while
 * mobile WITHOUT opening Dispatch. Triage line (ntfy title) always carries
 * subject + recipient; the body leads with the actual composed content
 * (To/Subject then full body), truncating only if it would exceed ntfy's
 * ~4KB cap.
 */
export async function pushDraftSnapshotNtfy(args: {
  to: string; subject: string; body: string; cc?: string; bcc?: string; link: string;
}): Promise<string> {
  const topic = process.env.CLAIM_MONITOR_NTFY_TOPIC || "dino-claims-alerts-fpx";
  const server = process.env.CLAIM_MONITOR_NTFY_SERVER || "https://ntfy.sh";

  const subjShort = (args.subject || "(no subject)").slice(0, 80);
  const title =
    `[DRAFT] ${subjShort} -> ${shortRecipient(args.to)}`
      .replace(/[^\x00-\x7F]/g, "").trim().slice(0, 120) || "[DRAFT] review draft";

  const head =
    `To: ${args.to}\n` +
    (args.cc ? `Cc: ${args.cc}\n` : "") +
    (args.bcc ? `Bcc: ${args.bcc}\n` : "") +
    `Subject: ${args.subject}\n\n`;
  const LIMIT = 3800;                       // safely under ntfy's ~4096B cap
  const linkLine = `\n\n— open/edit/send: ${args.link}`;
  let msg: string;
  if ((head + args.body + linkLine).length <= LIMIT) {
    msg = head + args.body + linkLine;
  } else {
    const room = LIMIT - head.length - linkLine.length - 40;
    msg = head + args.body.slice(0, Math.max(0, room)) +
      `\n\n…[truncated — open Gmail for full draft]` + linkLine;
  }

  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        "Title": title,
        "Priority": "4",
        "Tags": "memo",
        // Tapping the notification body opens the draft directly (no need to
        // find/select a URL in the text — solves the lock-screen problem).
        "Click": args.link,
        // Plus an explicit tappable button. ntfy simple Actions format:
        // "<action>, <label>, <url>". The Gmail link has no commas so this
        // is safe unquoted.
        "Actions": `view, Open draft, ${args.link}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: msg,
    });
    return res.ok ? "sent" : `ntfy HTTP ${res.status}`;
  } catch (e: any) {
    return `ntfy error: ${e?.message || e}`;
  }
}

export async function gmailCreateDraft(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const raw = encodeEmail(args);
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });
  const draftId = res.data.id ?? "";
  const messageId = res.data.message?.id ?? "";
  const link = `https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`;

  // Read the draft BACK from Gmail (verify what was actually stored — the
  // ntfy snapshot must reflect the SERVER draft, not our inputs).
  let snapBody = "(could not read draft back)";
  let snapHeaders = "";
  let snapTo = args.to, snapSubject = args.subject;
  let snapCc: string | undefined = args.cc, snapBcc: string | undefined = args.bcc;
  try {
    const got = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    const payload = got.data.message?.payload;
    const headers = payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => (x.name ?? "").toLowerCase() === n)?.value ?? "";
    snapTo = h("to") || args.to;
    snapSubject = h("subject") || args.subject;
    snapCc = h("cc") || undefined;
    snapBcc = h("bcc") || undefined;
    snapHeaders =
      `To: ${snapTo}\n` +
      (snapCc ? `Cc: ${snapCc}\n` : "") +
      (snapBcc ? `Bcc: ${snapBcc}\n` : "") +
      `Subject: ${snapSubject}`;
    snapBody = decodeDraftBody(payload).trim() || "(BODY EMPTY IN STORED DRAFT — check before sending)";
  } catch (e: any) {
    snapBody = `(drafts.get failed: ${e?.message || e})`;
  }

  const ntfyStatus = await pushDraftSnapshotNtfy({
    to: snapTo, subject: snapSubject, body: snapBody, cc: snapCc, bcc: snapBcc, link,
  });

  return makeTextContent(
    `Draft created (NOT sent). Snapshot pushed to ntfy: ${ntfyStatus}\n` +
    `Draft ID: ${draftId}\nMessage ID: ${messageId}\nOpen in Gmail: ${link}\n\n` +
    `--- VERIFIED SNAPSHOT (server-stored draft) ---\n${snapHeaders}\n\n${snapBody}`
  );
}

// ─── Scheduled send (queue #9) ────────────────────────────────────────────────
//
// Gmail's native "Schedule send" is NOT exposed by the Gmail API (verified
// against googleapis v144 / gmail v1: no sendAt/scheduledSend field on Draft or
// Message, no settings.scheduledSend resource). So we emulate it: persist a real
// Gmail DRAFT tagged with a label + an X-Mcp-Scheduled-Send header, and arm an
// in-process timer that calls drafts.send at send_at. The draft is durable in
// Gmail (survives a Railway redeploy); recoverScheduledSends() re-arms timers
// from the labeled drafts on boot.
//
// LIMITATION (by design, documented for the operator): the send fires only while
// this server is running. If the process is down at the exact send_at, the email
// goes out late on the next boot (recovery), not on time. True fire-while-offline
// scheduling would need a different transport (SMTP relay) or Gmail's own UI.

const SCHEDULED_LABEL = "MCP/Scheduled-Send";
const SCHEDULED_HEADER = "X-Mcp-Scheduled-Send";
const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60 * 1000; // refuse > 1 year out
const SETTIMEOUT_MAX = 2_147_483_647;              // setTimeout cap (~24.8 days)
const armedSends = new Map<string, NodeJS.Timeout>();

async function ensureScheduledLabel(gmail: any): Promise<string | undefined> {
  try {
    const list = await gmail.users.labels.list({ userId: "me" });
    const found = (list.data.labels ?? []).find((l: any) => l.name === SCHEDULED_LABEL);
    if (found?.id) return found.id;
    const created = await gmail.users.labels.create({
      userId: "me",
      requestBody: { name: SCHEDULED_LABEL, labelListVisibility: "labelHide", messageListVisibility: "show" },
    });
    return created.data.id ?? undefined;
  } catch (e: any) {
    console.error(`[gmail-scheduled] ensureScheduledLabel failed: ${e?.message || e}`);
    return undefined;
  }
}

async function fireScheduledSend(draftId: string): Promise<void> {
  armedSends.delete(draftId);
  try {
    const gmail = await getGmail();
    await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    console.log(`[gmail-scheduled] sent scheduled draft ${draftId}`);
  } catch (e: any) {
    console.error(`[gmail-scheduled] failed to send scheduled draft ${draftId}: ${e?.message || e}`);
    const server = process.env.CLAIM_MONITOR_NTFY_SERVER || "https://ntfy.sh";
    const topic = process.env.CLAIM_MONITOR_NTFY_TOPIC || "dino-claims-alerts-fpx";
    fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { "Title": "[SCHED-SEND FAILED]", "Priority": "5", "Tags": "warning", "Content-Type": "text/plain; charset=utf-8" },
      body: `Scheduled send of draft ${draftId} failed: ${e?.message || e}. The draft is still in Drafts — send it manually.`,
    }).catch(() => { /* swallow */ });
  }
}

// Arm a one-shot timer. setTimeout maxes out at ~24.8 days, so for longer
// horizons we hop: sleep the max, then re-arm on the remaining time.
function armScheduledSend(draftId: string, sendAtMs: number): void {
  if (armedSends.has(draftId)) return;
  const remaining = sendAtMs - Date.now();
  const t = setTimeout(() => {
    armedSends.delete(draftId);
    if (Date.now() >= sendAtMs) {
      fireScheduledSend(draftId).catch(() => { /* swallow */ });
    } else {
      armScheduledSend(draftId, sendAtMs); // next hop
    }
  }, Math.max(0, Math.min(remaining, SETTIMEOUT_MAX)));
  armedSends.set(draftId, t);
}

/**
 * Create a Gmail draft and auto-send it at `send_at` (ISO-8601). Because the
 * send fires automatically, this enforces the SAME strict-send guardrail as
 * gmail_send_email for third-party recipients (internal-only bypasses). Cancel
 * before send_at with gmail_delete_draft(draft_id=...).
 */
export async function gmailCreateDraftScheduled(args: {
  to: string;
  subject: string;
  body: string;
  send_at: string;
  cc?: string;
  bcc?: string;
  approved_at_iso_timestamp?: string;
  force_send?: boolean;
}): Promise<CallToolResult> {
  const sendAtMs = Date.parse((args.send_at || "").trim());
  if (!Number.isFinite(sendAtMs)) {
    return makeTextContent(`❌ gmail_create_draft_scheduled: invalid send_at "${args.send_at}" (need ISO-8601).`);
  }
  if (sendAtMs <= Date.now()) {
    return makeTextContent(`❌ gmail_create_draft_scheduled: send_at is in the past (${args.send_at}). Pick a future time.`);
  }
  if (sendAtMs - Date.now() > MAX_SCHEDULE_MS) {
    return makeTextContent(`❌ gmail_create_draft_scheduled: send_at is more than 1 year out — refusing.`);
  }

  // Strict-send guardrail — a scheduled send auto-fires, so it needs the same
  // approval as a direct send (matches gmail_send_email).
  const decision = checkSendGuardrail({
    tool: "gmail_create_draft_scheduled",
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    approved_at_iso_timestamp: args.approved_at_iso_timestamp,
    force_send: args.force_send,
  });
  if (!decision.ok) return makeTextContent(decision.reason);

  const gmail = await getGmail();
  const isoSendAt = new Date(sendAtMs).toISOString();
  const raw = encodeEmail({ ...args, extraHeaders: { [SCHEDULED_HEADER]: isoSendAt } });
  const created = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  const draftId = created.data.id ?? "";
  const messageId = created.data.message?.id ?? "";

  // Label the draft message so recoverScheduledSends() can find it after a restart.
  const labelId = await ensureScheduledLabel(gmail);
  if (labelId && messageId) {
    try {
      await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: [labelId] } });
    } catch (e: any) {
      console.error(`[gmail-scheduled] label add failed for ${messageId}: ${e?.message || e}`);
    }
  }

  armScheduledSend(draftId, sendAtMs);

  const link = `https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`;

  // Persist to scheduled_sends.json so the launchd sweep can act as a backstop
  // if this in-process timer misses (server down at send_at). Both paths are
  // idempotent against the underlying Gmail draft — whichever fires first wins;
  // the other gets 404 from drafts.send and the sweep drops the entry.
  const internalOnly = guardrailAllInternal(args.to, args.cc, args.bcc);
  const entry: ScheduledSend = {
    draft_id: draftId,
    message_id: messageId || undefined,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    link,
    send_at_iso: isoSendAt,
    auto_send: internalOnly,
    recipients_internal_only: internalOnly,
    created_at_iso: new Date().toISOString(),
    surfaced_at_iso: null,
  };
  try {
    appendToSchedule(entry);
  } catch (e: any) {
    console.error(`[gmail-scheduled] queue write failed for ${draftId}: ${e?.message || e}`);
  }

  const ntfyStatus = await pushDraftSnapshotNtfy({
    to: args.to, subject: `[SCHEDULED ${isoSendAt}] ${args.subject}`, body: args.body, cc: args.cc, bcc: args.bcc, link,
  });

  return makeTextContent(
    `✅ Scheduled draft created. Auto-sends at ${isoSendAt}.\n` +
    `Draft ID: ${draftId}\nMessage ID: ${messageId}\nSnapshot ntfy: ${ntfyStatus}\nOpen in Gmail: ${link}\n\n` +
    `Firing: in-process timer (on-time while the MCP server is running) + launchd sweep at ~5-min cadence (backstop if the server was down at send_at).\n` +
    `To CANCEL: gmail_delete_draft(draft_id="${draftId}") before send_at — that stops the timer AND lets the sweep drop the entry on its next tick.`
  );
}

/**
 * On boot, re-arm timers for any scheduled-send drafts still pending (the
 * timers themselves are in-memory and lost on restart; the labeled drafts +
 * X-Mcp-Scheduled-Send header are the durable record).
 */
export async function recoverScheduledSends(): Promise<void> {
  try {
    const gmail = await getGmail();
    const labelId = await ensureScheduledLabel(gmail);
    if (!labelId) return;
    const list = await gmail.users.drafts.list({ userId: "me", maxResults: 100 });
    const drafts = list.data.drafts ?? [];
    let rearmed = 0;
    for (const d of drafts) {
      if (!d.id) continue;
      try {
        const got = await gmail.users.drafts.get({ userId: "me", id: d.id, format: "metadata" });
        const msg = got.data.message;
        if (!msg?.labelIds?.includes(labelId)) continue;
        const headers = msg.payload?.headers ?? [];
        const sched = headers.find((h: any) => (h.name ?? "").toLowerCase() === SCHEDULED_HEADER.toLowerCase())?.value;
        if (!sched) continue;
        const sendAtMs = Date.parse(sched);
        if (!Number.isFinite(sendAtMs)) continue;
        armScheduledSend(d.id, sendAtMs);
        rearmed++;
      } catch { /* skip this draft */ }
    }
    if (rearmed > 0) console.log(`[gmail-scheduled] recovered ${rearmed} scheduled send(s) on boot`);
  } catch (e: any) {
    console.error(`[gmail-scheduled] recoverScheduledSends failed: ${e?.message || e}`);
  }
}

/**
 * Permanently delete a Gmail draft by ID. Useful when a draft was created in
 * error or has been superseded — Gmail's UI doesn't expose batch-delete from
 * the drafts folder cleanly, but the API does. Returns success/failure plus
 * the (brief) snapshot we had of the deleted draft for the audit trail.
 */
export async function gmailDeleteDraft(args: { draft_id: string }): Promise<CallToolResult> {
  if (!args.draft_id) return makeTextContent("❌ draft_id is required.");
  const gmail = await getGmail();
  // Capture a small audit snapshot before deletion so we can surface what
  // disappeared. Best-effort; deletion proceeds even if the snapshot fails
  // (e.g., draft already gone).
  let snapshot = "(could not read draft before delete)";
  try {
    const got = await gmail.users.drafts.get({
      userId: "me",
      id: args.draft_id,
      format: "metadata",
    });
    const headers = got.data.message?.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => (x.name ?? "").toLowerCase() === n)?.value ?? "";
    snapshot = `To: ${h("to")}${h("cc") ? ` | Cc: ${h("cc")}` : ""} | Subject: ${h("subject")}`;
  } catch { /* ignore */ }

  try {
    await gmail.users.drafts.delete({ userId: "me", id: args.draft_id });
    return makeTextContent(`✅ Draft ${args.draft_id} deleted.\nDeleted draft snapshot: ${snapshot}`);
  } catch (e: any) {
    return makeTextContent(`❌ Failed to delete draft ${args.draft_id}: ${e?.message || e}`);
  }
}

/**
 * Send an existing Gmail draft and remove it from the drafts folder in one
 * API call (users.drafts.send). This is the right tool when a draft was
 * created via gmail_create_draft (or in the Gmail UI), reviewed, and is
 * ready to ship — sending via gmail_send_email would orphan the draft.
 *
 * STRICT-SEND GUARDRAIL: the recipients (To/Cc/Bcc) are read from the
 * server-stored draft BEFORE send and run through the same third-party
 * check as gmail_send_email. This closes the auto-reply gap (incident
 * 2026-06-04/05): automation that drafted then immediately called
 * gmail_send_draft was shipping un-reviewed mail. Now an internal-only
 * draft still ships freely; a third-party draft requires the explicit
 * approved_at_iso_timestamp (within 15 min) AND force_send=true.
 *
 * Reads the draft back BEFORE send so we have a verified snapshot of what
 * actually got sent for the audit trail. Returns the resulting message+
 * thread IDs and the snapshot.
 */
export async function gmailSendDraft(args: {
  draft_id: string;
  approved_at_iso_timestamp?: string;
  force_send?: boolean;
}): Promise<CallToolResult> {
  if (!args.draft_id) return makeTextContent("❌ draft_id is required.");
  const gmail = await getGmail();

  // Snapshot before send — same pattern as gmail_create_draft uses post-create.
  let snapHeaders = "";
  let snapBody = "(could not read draft before send)";
  let snapTo = "", snapCc: string | undefined, snapBcc: string | undefined;
  try {
    const got = await gmail.users.drafts.get({ userId: "me", id: args.draft_id, format: "full" });
    const payload = got.data.message?.payload;
    const headers = payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => (x.name ?? "").toLowerCase() === n)?.value ?? "";
    snapTo = h("to");
    snapCc = h("cc") || undefined;
    snapBcc = h("bcc") || undefined;
    snapHeaders =
      `To: ${snapTo}\n` +
      (snapCc ? `Cc: ${snapCc}\n` : "") +
      (snapBcc ? `Bcc: ${snapBcc}\n` : "") +
      `Subject: ${h("subject")}`;
    snapBody = decodeDraftBody(payload).trim() || "(BODY EMPTY IN STORED DRAFT)";
  } catch (e: any) {
    snapBody = `(drafts.get failed: ${e?.message || e})`;
  }

  // Guardrail on the SERVER-STORED draft recipients, not call args (which has
  // no recipients). If we couldn't read the draft, the empty recipient list
  // is treated as "not internal" by the guardrail, so an unreadable draft
  // cannot accidentally pass the internal-only bypass.
  const decision = checkSendGuardrail({
    tool: "gmail_send_draft",
    to: snapTo,
    cc: snapCc,
    bcc: snapBcc,
    approved_at_iso_timestamp: args.approved_at_iso_timestamp,
    force_send: args.force_send,
  });
  if (!decision.ok) {
    return makeTextContent(
      decision.reason +
        `\n\nDraft snapshot (not sent):\n${snapHeaders}\n\n${snapBody}`,
    );
  }

  try {
    const res = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: args.draft_id },
    });
    const messageId = res.data.id ?? "";
    const threadId = res.data.threadId ?? "";
    return makeTextContent(
      `✅ Draft ${args.draft_id} sent (and removed from Drafts).\n` +
      `Path: ${decision.path === "internal_only" ? "internal-only (guardrail skipped)" : "force_send with fresh approval"}\n` +
      `Sent Message ID: ${messageId}\nThread ID: ${threadId}\n\n` +
      `--- SENT SNAPSHOT (was in the draft we just sent) ---\n${snapHeaders}\n\n${snapBody}`
    );
  } catch (e: any) {
    return makeTextContent(`❌ Failed to send draft ${args.draft_id}: ${e?.message || e}`);
  }
}

export async function gmailFindEmail(args: {
  query: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: args.query,
    maxResults: args.max_results ?? 10,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) {
    return makeTextContent("No emails found matching that query.");
  }

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      })
    )
  );

  const summaries = details.map((d) => {
    const headers = d.data.payload?.headers ?? [];
    const get = (name: string) =>
      headers.find((h) => h.name === name)?.value ?? "";
    return `ID: ${d.data.id}\nFrom: ${get("From")}\nDate: ${get("Date")}\nSubject: ${get("Subject")}`;
  });

  return makeTextContent(summaries.join("\n\n---\n\n"));
}

// Recursively walk MIME parts to find the best readable body
function extractBody(payload: any): string {
  // Direct body on this node
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  const parts: any[] = payload?.parts ?? [];

  // Prefer text/plain anywhere in the tree
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
  }

  // Recurse into multipart/* containers (alternative, mixed, related, etc.)
  for (const part of parts) {
    if (part.mimeType?.startsWith("multipart/")) {
      const found = extractBody(part);
      if (found) return found;
    }
  }

  // Fall back to text/html — strip tags for readability
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const html = Buffer.from(part.body.data, "base64").toString("utf-8");
      return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  }

  return "";
}

// Recursively collect attachment metadata from a Gmail payload tree.
// A part is an attachment when it has a non-empty filename + a body.attachmentId.
type AttachmentMeta = {
  filename: string;
  mime_type: string;
  attachment_id: string;
  size_bytes: number;
};

function collectAttachments(payload: any, out: AttachmentMeta[] = []): AttachmentMeta[] {
  if (!payload) return out;
  const filename = payload.filename || "";
  const attachmentId = payload.body?.attachmentId;
  if (filename && attachmentId) {
    out.push({
      filename,
      mime_type: payload.mimeType || "application/octet-stream",
      attachment_id: attachmentId,
      size_bytes: Number(payload.body?.size ?? 0),
    });
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) collectAttachments(p, out);
  }
  return out;
}

export async function gmailGetEmail(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  const res = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "full",
  });

  const headers = res.data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const body = extractBody(res.data.payload);
  const attachments = collectAttachments(res.data.payload);

  const lines = [
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Date: ${get("Date")}`,
    `Subject: ${get("Subject")}`,
    `Thread ID: ${res.data.threadId}`,
    `Message ID: ${res.data.id}`,
  ];

  if (attachments.length > 0) {
    lines.push("");
    lines.push(`Attachments (${attachments.length}):`);
    for (const a of attachments) {
      const sizeKb = a.size_bytes ? `${(a.size_bytes / 1024).toFixed(1)} KB` : "?";
      lines.push(`  - ${a.filename} (${a.mime_type}, ${sizeKb})`);
      lines.push(`    attachment_id: ${a.attachment_id}`);
    }
  }

  lines.push("");
  lines.push(body || "(no readable body found)");

  return makeTextContent(lines.join("\n"));
}

export async function gmailReplyToEmail(args: {
  message_id: string;
  body: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();

  const original = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "metadata",
    metadataHeaders: ["Subject", "From", "Message-ID"],
  });

  const headers = original.data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const subject = get("Subject").startsWith("Re:")
    ? get("Subject")
    : `Re: ${get("Subject")}`;

  const raw = encodeEmail({
    to: get("From"),
    subject,
    body: args.body,
    replyToMessageId: get("Message-ID"),
  });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: original.data.threadId! },
  });

  return makeTextContent(`Reply sent. Message ID: ${res.data.id}`);
}

export async function gmailDownloadAttachment(args: {
  message_id: string;
  attachment_id?: string;
  dest_path: string;
  drive_file_id?: string;
}): Promise<CallToolResult> {
  const destPath = path.resolve(args.dest_path);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // ── Path A: drive_file_id supplied directly ──────────────────────────────
  if (args.drive_file_id) {
    return downloadFromDrive(args.drive_file_id, destPath);
  }

  // ── Path B: standard Gmail attachment ────────────────────────────────────
  if (args.attachment_id) {
    const gmail = await getGmail();
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: args.message_id,
      id: args.attachment_id,
    });
    const data = att.data.data;
    if (!data) return makeTextContent("Attachment has no data.");
    const buf = Buffer.from(data, "base64url");
    fs.writeFileSync(destPath, buf);
    return makeTextContent(`Attachment saved: ${destPath}\nSize: ${(buf.length / 1024).toFixed(1)} KB`);
  }

  // ── Path C: no attachment_id — scan body for Drive links ─────────────────
  const gmail = await getGmail();
  const msg = await gmail.users.messages.get({ userId: "me", id: args.message_id, format: "full" });
  const body = extractBody(msg.data.payload);

  const drivePattern = /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = drivePattern.exec(body)) !== null) ids.push(m[1]);

  if (ids.length === 0) {
    return makeTextContent(
      `No attachment_id provided and no Google Drive links found in message ${args.message_id}.\n` +
      "Use gmail_get_email to inspect the message and pass attachment_id or drive_file_id."
    );
  }

  // Download first Drive link found
  return downloadFromDrive(ids[0], destPath, ids.length > 1 ? ids : undefined);
}

async function downloadFromDrive(
  fileId: string,
  destPath: string,
  allIds?: string[]
): Promise<CallToolResult> {
  const { google: goog } = await import("googleapis");
  const { getGoogleAuthClient } = await import("../auth/google.js");
  const auth = await getGoogleAuthClient();
  const drive = goog.drive({ version: "v3", auth });

  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    fs.writeFileSync(destPath, buf);
    const extra = allIds && allIds.length > 1
      ? `\nOther Drive IDs found in message: ${allIds.slice(1).join(", ")}`
      : "";
    return makeTextContent(
      `Drive file downloaded: ${destPath}\nFile ID: ${fileId}\nSize: ${(buf.length / 1024).toFixed(1)} KB${extra}`
    );
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code ?? "unknown";
    if (status === 403 || status === 404) {
      return makeTextContent(
        `Cannot download Drive file ${fileId} — access denied or file not found.\n` +
        `Status: ${status}\n` +
        `Open in browser: https://drive.google.com/file/d/${fileId}/view\n` +
        (allIds && allIds.length > 1 ? `Other IDs in message: ${allIds.slice(1).join(", ")}` : "")
      );
    }
    throw err;
  }
}

export async function gmailArchiveEmail(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const gmail = await getGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: args.message_id,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
  return makeTextContent(`Email ${args.message_id} archived.`);
}
