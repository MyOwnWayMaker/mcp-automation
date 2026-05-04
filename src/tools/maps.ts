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

export type LatLng = { lat: number; lng: number };

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

// ─── Quadrant / service-area classification ────────────────────────────────────

export const HOME_LAT = 34.1524516;
export const HOME_LNG = -118.4297816;
export const HOME_LABEL = "4470 Ventura Canyon Ave, Sherman Oaks, CA 91423";
export const CENTRAL_RADIUS_MILES = 5.0;
const EARTH_RADIUS_MILES = 3958.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

function bearingDegrees(from: LatLng, to: LatLng): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLng = toRadians(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export type Quadrant = "Central" | "N" | "W" | "E" | "S";

/**
 * Classify a point into a service-area zone relative to home (Sherman Oaks).
 * Zones are organized by freeway corridor — points reachable via the same
 * route from home land in the same zone, so a day's claims in one zone can
 * be batched.
 *
 * Priority order (first match wins):
 *   1. Central: ≤ 5.0 mi from home (covers Sherman Oaks, Studio City,
 *      Encino, Van Nuys, N. Hollywood, etc.)
 *   2. N: lat ≥ 34.20 — Northridge, Granada Hills, Mission Hills, Sylmar,
 *      Santa Clarita, Valencia (405 N / 5 N corridor)
 *   3. W: lng ≤ -118.55 — Tarzana, Woodland Hills, Calabasas, Agoura,
 *      Westlake, Thousand Oaks, Topanga, Malibu (101 W / 27 corridor)
 *   4. E: (lat ≥ 34.05 AND lng ≥ -118.38) OR (lat ≥ 33.90 AND lng ≥ -117.85)
 *      — Burbank, Glendale, Pasadena, Hollywood, DTLA, Eagle Rock AND
 *      Pomona, Ontario, Rancho Cucamonga, San Bernardino, Riverside
 *      (101 E / 134 / 5 / 170 / 210 / 10 corridors — single-day routable)
 *   5. S: everything else — Beverly Hills, Westwood, Santa Monica, Culver
 *      City, LAX, Inglewood, South Bay, Orange County, San Diego
 *      (405 S / 5 S corridor)
 */
export function classifyPoint(p: LatLng, origin: LatLng): Quadrant {
  const dist = haversineMiles(origin, p);
  if (dist <= CENTRAL_RADIUS_MILES) return "Central";
  if (p.lat >= 34.20) return "N";
  if (p.lng <= -118.55) return "W";
  if ((p.lat >= 34.05 && p.lng >= -118.38) || (p.lat >= 33.90 && p.lng >= -117.85)) return "E";
  return "S";
}

export type ClassifyQuadrantResult =
  | {
      ok: true;
      quadrant: Quadrant;
      lat: number;
      lng: number;
      formatted_address?: string;
      distance_miles: number;
      bearing_degrees: number;
      origin_used: { lat: number; lng: number; label: string };
    }
  | { ok: false; error: string; status?: string };

export async function mapsClassifyQuadrant(args: {
  address?: string;
  location?: LatLng;
  origin?: LatLng;
}): Promise<CallToolResult> {
  if (!args.address && !args.location) {
    return ok(JSON.stringify({ ok: false, error: "Provide address or location" }, null, 2));
  }
  if (args.address && args.location) {
    return ok(JSON.stringify({ ok: false, error: "Provide either address OR location, not both" }, null, 2));
  }

  const origin = args.origin ?? { lat: HOME_LAT, lng: HOME_LNG };
  const originLabel = args.origin ? "custom" : "home";

  let target: LatLng;
  let formatted_address: string | undefined;
  if (args.address) {
    const g = await geocode(args.address);
    if (!g.ok) {
      return ok(JSON.stringify({ ok: false, error: `geocode failed: ${g.error}`, status: g.status }, null, 2));
    }
    target = { lat: g.lat, lng: g.lng };
    formatted_address = g.formatted_address;
  } else {
    target = args.location!;
  }

  const distance_miles = haversineMiles(origin, target);
  let bearing = bearingDegrees(origin, target);
  if (bearing < 0) bearing += 360;
  const quadrant = classifyPoint(target, origin);

  const result: ClassifyQuadrantResult = {
    ok: true,
    quadrant,
    lat: target.lat,
    lng: target.lng,
    formatted_address,
    distance_miles: Math.round(distance_miles * 10) / 10,
    bearing_degrees: Math.round(bearing),
    origin_used: { lat: origin.lat, lng: origin.lng, label: originLabel === "home" ? HOME_LABEL : "custom origin" },
  };
  return ok(JSON.stringify(result, null, 2));
}
