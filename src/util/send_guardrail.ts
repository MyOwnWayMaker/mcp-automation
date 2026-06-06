/**
 * Shared strict-send guardrail used by every email-send tool exposed to the
 * MCP surface (gmail_send_email, gmail_send_draft, gmail_create_draft_scheduled,
 * notary_send_email, gmail_notary_reply_to_email).
 *
 * Centralized here so the four tools enforce ONE rule instead of drifting.
 *
 * Why: external automation (Cloud Dispatch, scheduled agents) is connected to
 * the same MCP server Hakiel uses. Without a uniform guardrail, any caller can
 * ship an auto-drafted reply without Hakiel's review. Several incidents
 * (Paul Kuhr 2026-05-19; auto-reply send-without-approval 2026-06-04/05)
 * trace back to gaps in this gate.
 *
 * Rule:
 *   - All recipients on internal domains (GMAIL_INTERNAL_DOMAINS, default
 *     "erseville.com") → bypass.
 *   - Otherwise require approved_at_iso_timestamp within the last 15 min
 *     AND force_send=true. Anything else → REFUSE with an explanatory
 *     message the caller surfaces back.
 *
 * The freshness window prevents a stale approval from being replayed. It is a
 * soft gate (an automated caller can synthesize a timestamp); hardening with
 * an HMAC-signed token is tracked as future work but out of scope for this
 * change — the immediate goal is to make blind auto-sends fail loudly.
 */

const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

function loadInternalDomains(): Set<string> {
  return new Set(
    (process.env.GMAIL_INTERNAL_DOMAINS || "erseville.com")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function extractRecipientDomains(...fields: (string | undefined)[]): string[] {
  const domains: string[] = [];
  for (const f of fields) {
    if (!f) continue;
    for (const part of f.split(",")) {
      const m = part.match(/<([^>]+)>/) || [null, part.trim()];
      const addr = (m[1] || "").trim().toLowerCase();
      const at = addr.indexOf("@");
      if (at > 0 && at < addr.length - 1) domains.push(addr.slice(at + 1));
    }
  }
  return domains;
}

export function allRecipientsInternal(...fields: (string | undefined)[]): boolean {
  const internal = loadInternalDomains();
  const domains = extractRecipientDomains(...fields);
  if (domains.length === 0) return false; // no parseable recipient → not internal-only
  return domains.every((d) => internal.has(d));
}

export type GuardrailDecision =
  | { ok: true; path: "internal_only" | "approved_override" }
  | { ok: false; reason: string };

/**
 * Evaluate the strict-send guardrail.
 *
 * @param tool       Name of the calling tool — surfaced in the refusal message.
 * @param to         To-header value (comma-separated allowed).
 * @param cc         Cc-header value.
 * @param bcc        Bcc-header value.
 * @param approvedAt ISO-8601 timestamp of an explicit Hakiel approval.
 * @param forceSend  Must be `true` alongside a fresh `approvedAt` to override.
 */
export function checkSendGuardrail(args: {
  tool: string;
  to?: string;
  cc?: string;
  bcc?: string;
  approved_at_iso_timestamp?: string;
  force_send?: boolean;
}): GuardrailDecision {
  if (allRecipientsInternal(args.to, args.cc, args.bcc)) {
    return { ok: true, path: "internal_only" };
  }
  const raw = (args.approved_at_iso_timestamp || "").trim();
  const ms = raw ? Date.parse(raw) : NaN;
  const age = Number.isFinite(ms) ? Date.now() - ms : NaN;
  const fresh =
    Number.isFinite(age) && age >= 0 && age <= APPROVAL_WINDOW_MS;
  if (args.force_send && fresh) {
    return { ok: true, path: "approved_override" };
  }
  const internal = [...loadInternalDomains()].join(", ") || "(none)";
  const recipients =
    `to=${args.to ?? "(empty)"}` +
    (args.cc ? ` | cc=${args.cc}` : "") +
    (args.bcc ? ` | bcc=${args.bcc}` : "");
  return {
    ok: false,
    reason:
      `❌ ${args.tool} REFUSED: third-party recipient(s) detected and no valid pre-send approval.\n\n` +
      `Recipients: ${recipients}\n` +
      `Internal domains (no-check): ${internal}\n\n` +
      "To proceed, ONE of:\n" +
      "  (1) Create a draft (gmail_create_draft / pickford_drafter / important_drafter) and let Hakiel send it manually from Gmail.\n" +
      "  (2) Re-call with approved_at_iso_timestamp=<ISO-8601 within last 15 min> AND force_send=true — only when an explicit Hakiel approval has just been received.\n\n" +
      "This block is intentional. Automated callers (Cloud Dispatch, agents, schedulers) MUST NOT auto-fire this tool against third-party recipients without a fresh human approval.",
  };
}
