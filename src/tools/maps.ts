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

export type DriveTimeResult =
  | {
      ok: true;
      origin_address: string;
      destination_address: string;
      duration_seconds: number;
      duration_text: string;
      distance_meters: number;
      distance_text: string;
      duration_in_traffic_seconds?: number;
      duration_in_traffic_text?: string;
    }
  | { ok: false; error: string; status?: string };

const DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

type LatLng = { lat: number; lng: number };

function toLocationParam(loc: string | LatLng): string {
  if (typeof loc === "string") return loc;
  return `${loc.lat},${loc.lng}`;
}

/**
 * Reusable drive-time helper. Used by claim-scheduling logic to determine
 * travel time between home and a claim address, and between sequential
 * claim stops.
 *
 * `departure_time` enables traffic-aware estimates ("now" or unix seconds).
 * Without it, results are free-flow estimates.
 */
export async function driveTime(args: {
  origin: string | LatLng;
  destination: string | LatLng;
  mode?: "driving" | "walking" | "bicycling" | "transit";
  departure_time?: number | "now";
}): Promise<DriveTimeResult> {
  if (!args.origin) return { ok: false, error: "origin is required" };
  if (!args.destination) return { ok: false, error: "destination is required" };

  const key = process.env.GOOGLE_DISTANCE_MATRIX_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: "GOOGLE_DISTANCE_MATRIX_API_KEY not set in environment",
    };
  }

  const params = new URLSearchParams({
    origins: toLocationParam(args.origin),
    destinations: toLocationParam(args.destination),
    mode: args.mode ?? "driving",
    units: "imperial",
    key,
  });
  if (args.departure_time !== undefined) {
    params.set("departure_time", String(args.departure_time));
    params.set("traffic_model", "best_guess");
  }

  const response = await fetch(`${DISTANCE_MATRIX_URL}?${params.toString()}`);
  if (!response.ok) {
    return {
      ok: false,
      error: `Distance Matrix API returned HTTP ${response.status} ${response.statusText}`,
    };
  }

  const data = (await response.json()) as {
    status: string;
    error_message?: string;
    origin_addresses: string[];
    destination_addresses: string[];
    rows: Array<{
      elements: Array<{
        status: string;
        duration?: { value: number; text: string };
        distance?: { value: number; text: string };
        duration_in_traffic?: { value: number; text: string };
      }>;
    }>;
  };

  if (data.status !== "OK") {
    return {
      ok: false,
      status: data.status,
      error: data.error_message || `Distance Matrix API status: ${data.status}`,
    };
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element) {
    return { ok: false, status: "NO_RESULT", error: "Empty rows in API response" };
  }
  if (element.status !== "OK") {
    return {
      ok: false,
      status: element.status,
      error: `Element status: ${element.status} (e.g. ZERO_RESULTS, NOT_FOUND)`,
    };
  }
  if (!element.duration || !element.distance) {
    return {
      ok: false,
      status: "MISSING_FIELDS",
      error: "API returned OK but duration/distance fields are missing",
    };
  }

  return {
    ok: true,
    origin_address: data.origin_addresses[0],
    destination_address: data.destination_addresses[0],
    duration_seconds: element.duration.value,
    duration_text: element.duration.text,
    distance_meters: element.distance.value,
    distance_text: element.distance.text,
    duration_in_traffic_seconds: element.duration_in_traffic?.value,
    duration_in_traffic_text: element.duration_in_traffic?.text,
  };
}

export async function mapsDriveTime(args: {
  origin: string | LatLng;
  destination: string | LatLng;
  mode?: "driving" | "walking" | "bicycling" | "transit";
  departure_time?: number | "now";
}): Promise<CallToolResult> {
  const result = await driveTime(args);
  return ok(JSON.stringify(result, null, 2));
}
