import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import {
  geocode,
  classifyPoint,
  haversineMiles,
  HOME_LAT,
  HOME_LNG,
  type Quadrant,
} from "./maps.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export type ScannedEvent = {
  id: string;
  summary?: string;
  start: string;       // ISO datetime
  end: string;         // ISO datetime
  all_day: boolean;
  location?: string;
  // Geocoded fields — only present when the event has a location AND
  // geocoding succeeded.
  lat?: number;
  lng?: number;
  formatted_address?: string;
  quadrant?: Quadrant;
  distance_miles?: number;
  // True when the event has a location string but geocoding failed
  // (REQUEST_DENIED, ZERO_RESULTS, etc.). Caller can treat these as
  // unknown-location events.
  geocode_failed?: boolean;
  geocode_error?: string;
};

export type ScanCalendarResult =
  | {
      ok: true;
      range: { start: string; end: string };
      events: ScannedEvent[];
      home: { lat: number; lng: number };
      // Counts for quick scanning
      summary: {
        total: number;
        with_location: number;
        geocoded: number;
        per_quadrant: Record<string, number>;
      };
    }
  | { ok: false; error: string };

async function getCalendar() {
  const auth = await getGoogleAuthClient();
  return google.calendar({ version: "v3", auth });
}

/**
 * Scan calendar events over the next N days, geocode every event with a
 * location, and tag with the freeway-corridor quadrant relative to home.
 * Used by the post-claim slot picker (C3) to detect days where Hakiel will
 * already be in a given quadrant — those days are preferred for new claims
 * in the same zone.
 *
 * Skips all-day events from quadrant tagging (they don't constrain
 * scheduling), but includes them in the event list so the caller can see
 * them.
 */
export async function scanCalendarWithQuadrants(args: {
  days?: number;
  calendar_id?: string;
  time_min?: string;       // override "now" — useful for tests
  max_results?: number;
}): Promise<ScanCalendarResult> {
  const days = args.days ?? 3;
  const calendarId = args.calendar_id ?? "primary";
  const start = args.time_min ? new Date(args.time_min) : new Date();
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

  let cal: ReturnType<typeof google.calendar>;
  try {
    cal = await getCalendar();
  } catch (e: any) {
    return { ok: false, error: `Could not init calendar client: ${e?.message ?? e}` };
  }

  let items: any[] = [];
  try {
    const res = await cal.events.list({
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: args.max_results ?? 50,
    });
    items = res.data.items ?? [];
  } catch (e: any) {
    return { ok: false, error: `events.list failed: ${e?.message ?? e}` };
  }

  const home = { lat: HOME_LAT, lng: HOME_LNG };
  const events: ScannedEvent[] = [];

  // Cache geocoding per location string in case events repeat the same
  // location (e.g. a recurring meeting at HQ).
  const geoCache = new Map<string, { lat: number; lng: number; formatted: string } | { error: string }>();

  for (const item of items) {
    const startVal = item.start?.dateTime ?? item.start?.date;
    const endVal = item.end?.dateTime ?? item.end?.date;
    if (!startVal || !endVal) continue;
    const all_day = !item.start?.dateTime;

    const ev: ScannedEvent = {
      id: item.id,
      summary: item.summary,
      start: startVal,
      end: endVal,
      all_day,
      location: item.location || undefined,
    };

    if (item.location && !all_day) {
      const cached = geoCache.get(item.location);
      let geoOk: { lat: number; lng: number; formatted: string } | null = null;
      let geoErr: string | undefined;
      if (cached) {
        if ("error" in cached) geoErr = cached.error;
        else geoOk = cached;
      } else {
        const r = await geocode(item.location);
        if (r.ok) {
          geoOk = { lat: r.lat, lng: r.lng, formatted: r.formatted_address };
          geoCache.set(item.location, geoOk);
        } else {
          geoErr = r.error;
          geoCache.set(item.location, { error: r.error });
        }
      }
      if (geoOk) {
        ev.lat = geoOk.lat;
        ev.lng = geoOk.lng;
        ev.formatted_address = geoOk.formatted;
        ev.quadrant = classifyPoint({ lat: geoOk.lat, lng: geoOk.lng }, home);
        ev.distance_miles = Math.round(haversineMiles(home, { lat: geoOk.lat, lng: geoOk.lng }) * 10) / 10;
      } else {
        ev.geocode_failed = true;
        ev.geocode_error = geoErr;
      }
    }

    events.push(ev);
  }

  const per_quadrant: Record<string, number> = {};
  let geocoded = 0;
  let with_location = 0;
  for (const ev of events) {
    if (ev.location) with_location++;
    if (ev.quadrant) {
      geocoded++;
      per_quadrant[ev.quadrant] = (per_quadrant[ev.quadrant] ?? 0) + 1;
    }
  }

  return {
    ok: true,
    range: { start: start.toISOString(), end: end.toISOString() },
    events,
    home,
    summary: {
      total: events.length,
      with_location,
      geocoded,
      per_quadrant,
    },
  };
}

export async function scanCalendarWithQuadrantsTool(args: {
  days?: number;
  calendar_id?: string;
  time_min?: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const result = await scanCalendarWithQuadrants(args);
  return ok(JSON.stringify(result, null, 2));
}
