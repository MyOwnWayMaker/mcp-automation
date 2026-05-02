import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export type GeocodeResult =
  | {
      ok: true;
      lat: number;
      lng: number;
      formatted_address: string;
      place_id: string;
      location_type: string;
      partial_match: boolean;
    }
  | { ok: false; error: string; status?: string };

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * Reusable geocoding helper. Other tools (drive-time, claim-quadrant, etc.)
 * import this directly. Returns a discriminated-union result so callers can
 * branch on `result.ok` without try/catch.
 */
export async function geocode(address: string): Promise<GeocodeResult> {
  const trimmed = (address ?? "").trim();
  if (!trimmed) return { ok: false, error: "address is required" };

  const key = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: "GOOGLE_GEOCODING_API_KEY not set in environment",
    };
  }

  const url = `${GEOCODE_URL}?address=${encodeURIComponent(trimmed)}&key=${key}`;
  const response = await fetch(url);
  if (!response.ok) {
    return {
      ok: false,
      error: `Geocoding API returned HTTP ${response.status} ${response.statusText}`,
    };
  }

  const data = (await response.json()) as {
    status: string;
    error_message?: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number }; location_type: string };
      formatted_address: string;
      place_id: string;
      partial_match?: boolean;
    }>;
  };

  if (data.status !== "OK") {
    return {
      ok: false,
      status: data.status,
      error: data.error_message || `Geocoding API status: ${data.status}`,
    };
  }
  if (data.results.length === 0) {
    return { ok: false, status: "ZERO_RESULTS", error: "No results for address" };
  }

  const top = data.results[0];
  return {
    ok: true,
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    formatted_address: top.formatted_address,
    place_id: top.place_id,
    location_type: top.geometry.location_type,
    partial_match: top.partial_match === true,
  };
}

export async function mapsGeocode(args: { address: string }): Promise<CallToolResult> {
  const result = await geocode(args.address);
  return ok(JSON.stringify(result, null, 2));
}
