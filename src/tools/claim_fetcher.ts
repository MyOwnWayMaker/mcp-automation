import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { xactGetAssignment } from "./xactanalysis.js";
import { filetracGetClaim } from "./filetrac.js";
import type { ParsedAddress, Platform } from "./assignment_email.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export type UnifiedClaimDetails = {
  ok: true;
  platform: Platform;
  claim_number: string;
  carrier?: string;
  insured_name?: string;
  insured_phone?: string;
  insured_alt_phone?: string;
  insured_email?: string;
  loss_address?: ParsedAddress;
  mailing_address?: ParsedAddress;
  date_of_loss?: string;
  loss_type?: string;
  loss_description?: string;
  policy_number?: string;
  // Live-state fields (FileTrac only — pulled from claimView page)
  date_of_first_contact?: string;
  date_of_inspection?: string;
  date_complete?: string;
  // Always include the source-tool raw text so the caller can mine extra
  // fields the unified schema doesn't surface (e.g. coverage details, notes
  // count, status). For XA `client_policy` tab this is JSON; for FileTrac
  // and other XA tabs this is rendered text.
  source: {
    tool: "xact_get_assignment" | "filetrac_get_claim" | "fallback_only" | "manual_required";
    args?: Record<string, unknown>;
    raw_text?: string;
    error?: string;
  };
  // Tells caller whether they still need to log in to a portal manually
  // (AAN today, possibly other i-firm portals later).
  manual_fetch_required?: boolean;
  dashboard_url?: string;
  notes?: string;
};

export type FetchClaimDetailsResult =
  | UnifiedClaimDetails
  | { ok: false; error: string };

function mergeFallback(
  primary: Partial<UnifiedClaimDetails>,
  fallback: Partial<UnifiedClaimDetails> | undefined
): Partial<UnifiedClaimDetails> {
  if (!fallback) return primary;
  const out: Record<string, unknown> = { ...fallback };
  for (const [k, v] of Object.entries(primary)) {
    // Don't let primary overwrite fallback with empty/undefined values
    if (v === undefined || v === null || v === "") continue;
    if (k === "loss_address" || k === "mailing_address") {
      // Deep-merge addresses — primary fields override fallback fields
      // individually, so a partial address from one source still combines
      // with the other.
      const fallAddr = (fallback as any)[k] ?? {};
      const primAddr = (v as ParsedAddress) ?? {};
      const merged: ParsedAddress = { ...fallAddr };
      for (const [ak, av] of Object.entries(primAddr)) {
        if (av !== undefined && av !== null && av !== "") (merged as any)[ak] = av;
      }
      out[k] = merged;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Try to extract a JSON object out of an MCP tool's text response. XA's
// client_policy tab returns the structured payload as JSON in the text; if
// parsing fails we just return null and the caller falls back to fields
// from the parsed email.
function tryParseJson(text: string | undefined): any | null {
  if (!text) return null;
  // The text response sometimes has a header before the JSON. Find the
  // first { and try to parse from there.
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.substring(start));
  } catch {
    return null;
  }
}

// FileTrac's filetrac_get_claim returns formatted text like:
//   "File #: 81030678\nDate of First Contact: 4/22/2026\nDate of Inspection: ..."
// followed by a body text dump. Pull the date fields and file number.
function parseFiletracTextResponse(text: string): {
  file_number?: string;
  date_of_first_contact?: string;
  date_of_inspection?: string;
  date_complete?: string;
} {
  const out: any = {};
  const file = text.match(/File\s*#:\s*(\S+)/i);
  if (file && file[1]) out.file_number = file[1];
  const c1 = text.match(/Date of First Contact:\s*([^\n]+?)(?:\n|$)/i);
  if (c1 && !/not set/i.test(c1[1])) out.date_of_first_contact = c1[1].trim();
  const c2 = text.match(/Date of Inspection:\s*([^\n]+?)(?:\n|$)/i);
  if (c2 && !/not set/i.test(c2[1])) out.date_of_inspection = c2[1].trim();
  const c3 = text.match(/Date of Claim Complete:\s*([^\n]+?)(?:\n|$)/i);
  if (c3 && !/not set/i.test(c3[1])) out.date_complete = c3[1].trim();
  return out;
}

export async function fetchClaimDetails(args: {
  platform: Platform;
  claim_number: string;
  fallback?: Partial<UnifiedClaimDetails>;
  // When true (default), also call the platform tool to get live state
  // (current dates, latest address). When false, just return the fallback.
  // Useful when the post-claim automation already trusts the parsed email.
  refresh?: boolean;
}): Promise<FetchClaimDetailsResult> {
  if (!args.platform) return { ok: false, error: "platform is required" };
  if (!args.claim_number) return { ok: false, error: "claim_number is required" };
  const refresh = args.refresh !== false;

  // ── XactAnalysis ───────────────────────────────────────────────────────────
  if (args.platform === "xactanalysis") {
    if (!refresh) {
      return {
        ok: true,
        platform: "xactanalysis",
        claim_number: args.claim_number,
        ...args.fallback,
        source: { tool: "fallback_only" },
      } as UnifiedClaimDetails;
    }
    try {
      const callArgs = { mfn: args.claim_number, tab: "client_policy" as const };
      const result = await xactGetAssignment(callArgs);
      const c0 = result.content?.[0];
      const text = c0 && c0.type === "text" ? c0.text : undefined;
      const json = tryParseJson(text);
      const fromXa: Partial<UnifiedClaimDetails> = json
        ? {
            loss_address: json.loss_address ?? undefined,
            mailing_address: json.mailing_address ?? undefined,
            insured_name: json.insured?.name ?? undefined,
            insured_phone: json.insured?.phone ?? undefined,
            insured_email: json.insured?.email ?? undefined,
            policy_number: json.policy?.number ?? undefined,
          }
        : {};
      const merged = mergeFallback(fromXa, args.fallback);
      return {
        ok: true,
        platform: "xactanalysis",
        claim_number: args.claim_number,
        ...merged,
        source: {
          tool: "xact_get_assignment",
          args: callArgs,
          raw_text: text,
          error: json ? undefined : "Could not parse JSON from xact_get_assignment response",
        },
      };
    } catch (e: any) {
      return {
        ok: true,
        platform: "xactanalysis",
        claim_number: args.claim_number,
        ...args.fallback,
        source: {
          tool: "xact_get_assignment",
          args: { mfn: args.claim_number, tab: "client_policy" },
          error: e?.message ?? String(e),
        },
      } as UnifiedClaimDetails;
    }
  }

  // ── FileTrac ───────────────────────────────────────────────────────────────
  if (args.platform === "filetrac") {
    if (!refresh) {
      return {
        ok: true,
        platform: "filetrac",
        claim_number: args.claim_number,
        ...args.fallback,
        source: { tool: "fallback_only" },
      } as UnifiedClaimDetails;
    }
    try {
      const result = await filetracGetClaim({ claim_id: args.claim_number });
      const c0 = result.content?.[0];
      const text = c0 && c0.type === "text" ? c0.text : "";
      const parsed = parseFiletracTextResponse(text);
      const fromFt: Partial<UnifiedClaimDetails> = {
        date_of_first_contact: parsed.date_of_first_contact,
        date_of_inspection: parsed.date_of_inspection,
        date_complete: parsed.date_complete,
      };
      const merged = mergeFallback(fromFt, args.fallback);
      return {
        ok: true,
        platform: "filetrac",
        claim_number: args.claim_number,
        ...merged,
        source: {
          tool: "filetrac_get_claim",
          args: { claim_id: args.claim_number },
          raw_text: text,
        },
      };
    } catch (e: any) {
      return {
        ok: true,
        platform: "filetrac",
        claim_number: args.claim_number,
        ...args.fallback,
        source: {
          tool: "filetrac_get_claim",
          args: { claim_id: args.claim_number },
          error: e?.message ?? String(e),
        },
      } as UnifiedClaimDetails;
    }
  }

  // ── AAN portal — manual fetch required ─────────────────────────────────────
  if (args.platform === "aan") {
    return {
      ok: true,
      platform: "aan",
      claim_number: args.claim_number,
      ...args.fallback,
      manual_fetch_required: true,
      dashboard_url: "https://app.associatedadjusting.com/dashboards/adjuster",
      source: { tool: "manual_required" },
      notes: "AAN claims live behind a login portal. Until automated, fetch details manually from the dashboard URL.",
    };
  }

  // ── Unknown / personal sender — fallback only ──────────────────────────────
  if (args.platform === "manual") {
    return {
      ok: true,
      platform: "manual",
      claim_number: args.claim_number,
      ...args.fallback,
      manual_fetch_required: true,
      source: { tool: "manual_required" },
      notes: "Email came from a personal/unknown sender — no automated platform to fetch from. Use the parsed fallback fields only.",
    };
  }

  return { ok: false, error: `Unknown platform: ${args.platform}` };
}

export async function fetchClaimDetailsTool(args: {
  platform: Platform;
  claim_number: string;
  fallback?: Partial<UnifiedClaimDetails>;
  refresh?: boolean;
}): Promise<CallToolResult> {
  const result = await fetchClaimDetails(args);
  return ok(JSON.stringify(result, null, 2));
}
