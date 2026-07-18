import {
  calculateSegmentDistanceH3,
  haversineKm,
} from "./costCalculation.service";
import { segmentCrossesWater, type LatLng } from "./landMask.service";
import { routeLandSegment, routeOnLandGrid } from "./landGridRouter.service";

export type LandDistanceSource = "google" | "land_grid" | "h3";

export interface LandLegRoute {
  distance_km: number | null;
  duration_hours: number | null;
  source: LandDistanceSource;
  /** Leaflet `[lat, lng]` path when a non-straight route was resolved. */
  coordinates?: [number, number][] | null;
}

const routeCache = new Map<string, LandLegRoute>();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Great-circle distance along a polyline (sum of segment haversines). */
function polylineDistanceKm(points: LatLng[]): number | null {
  if (points.length < 2) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const km = haversineKm(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng
    );
    if (km == null) return null;
    total += km;
  }
  return round2(total);
}

function cacheKey(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  mode: string
): string {
  return `${mode}:${fromLat.toFixed(5)},${fromLng.toFixed(5)}->${toLat.toFixed(5)},${toLng.toFixed(5)}`;
}

export function getLandDistanceProvider(): "google" | "h3" {
  const raw = (process.env.LAND_DISTANCE_PROVIDER ?? "google").trim().toLowerCase();
  if (raw === "h3") return "h3";
  if (process.env.GOOGLE_MAPS_API_KEY?.trim()) return "google";
  return "h3";
}

function h3Leg(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  resolution?: number
): LandLegRoute {
  const d = calculateSegmentDistanceH3(fromLat, fromLng, toLat, toLng, resolution);
  return {
    distance_km: d.distance_km,
    duration_hours: null,
    source: "h3",
    coordinates: null,
  };
}

/** Decode Google Encoded Polyline Algorithm Format. */
export function decodeGooglePolyline(encoded: string): LatLng[] {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: LatLng[] = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coordinates;
}

interface GoogleDirectionsResponse {
  status: string;
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{
      distance?: { value?: number };
      duration?: { value?: number };
    }>;
  }>;
  error_message?: string;
}

async function googleLeg(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<LandLegRoute | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const origin = `${fromLat},${fromLng}`;
    const destination = `${toLat},${toLng}`;
    const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as GoogleDirectionsResponse;
    if (data.status !== "OK" || !data.routes?.[0]?.legs?.[0]) {
      console.warn(
        "[road-routing] Google Directions failed:",
        data.status,
        data.error_message ?? ""
      );
      return null;
    }

    const route = data.routes[0];
    const leg = route.legs![0];
    const meters = leg.distance?.value;
    const seconds = leg.duration?.value;
    if (meters == null || !Number.isFinite(meters)) return null;

    let coordinates: [number, number][] | null = null;
    const encoded = route.overview_polyline?.points;
    if (encoded) {
      const decoded = decodeGooglePolyline(encoded);
      if (decoded.length >= 2) {
        coordinates = decoded.map((p) => [p.lat, p.lng] as [number, number]);
      }
    }

    return {
      distance_km: round2(meters / 1000),
      duration_hours:
        seconds != null && Number.isFinite(seconds)
          ? round2(seconds / 3600)
          : null,
      source: "google",
      coordinates,
    };
  } catch (err) {
    console.warn(
      "[road-routing] Google Directions error:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function landGridLeg(from: LatLng, to: LatLng): LandLegRoute | null {
  const path = routeOnLandGrid(from, to) ?? routeLandSegment(from, to);
  if (!path || path.length < 2) return null;

  // Airport spits / piers often fall outside the land mask. Snapping them to
  // the opposite harbour shore yields a tiny inland stub — not a real road.
  // Treat large endpoint gaps as failure so we inflate (or use Google).
  const startGap = haversineKm(path[0].lat, path[0].lng, from.lat, from.lng);
  const endGap = haversineKm(
    path[path.length - 1].lat,
    path[path.length - 1].lng,
    to.lat,
    to.lng
  );
  if ((startGap != null && startGap > 2.5) || (endGap != null && endGap > 2.5)) {
    return null;
  }

  const km = polylineDistanceKm(path);
  if (km == null || km <= 0) return null;
  return {
    distance_km: km,
    duration_hours: null,
    source: "land_grid",
    coordinates: path.map((p) => [p.lat, p.lng] as [number, number]),
  };
}

/**
 * Geometry for the map when the true road path is unavailable: stay on land
 * even if the path stops at the coast near an offshore hub.
 */
function landGridGeometryOnly(from: LatLng, to: LatLng): [number, number][] | null {
  const path = routeOnLandGrid(from, to) ?? routeLandSegment(from, to);
  if (!path || path.length < 2) return null;
  return path.map((p) => [p.lat, p.lng] as [number, number]);
}

/**
 * When land-grid A* cannot connect (e.g. thin coastal spits missing from the
 * coarse land mask), inflate great-circle so cost is not the water chord.
 */
function inflateAcrossWater(
  from: LatLng,
  to: LatLng,
  resolution?: number
): LandLegRoute {
  const base = h3Leg(from.lat, from.lng, to.lat, to.lng, resolution);
  const hv = haversineKm(from.lat, from.lng, to.lat, to.lng);
  // Coastal detour vs straight harbour chord — ~1.45× is a stable lower bound
  // when the real road (e.g. Palisadoes) is missing from the land mask.
  const inflated = hv != null ? round2(hv * 1.45) : null;
  let distance_km = inflated ?? base.distance_km;
  if (inflated != null && base.distance_km != null) {
    // Prefer the larger of H3 and inflated, but never trust a wild H3 spike.
    distance_km =
      base.distance_km > inflated * 3
        ? inflated
        : Math.max(base.distance_km, inflated);
  }
  return {
    ...base,
    distance_km,
    source: "h3",
    coordinates: null,
  };
}

/**
 * Resolve a land path for map display (geometry + distance).
 * Prefers Google road path, then land-grid A* when the chord crosses water.
 */
export async function computeLandRoute(
  from: LatLng,
  to: LatLng,
  resolution?: number
): Promise<LandLegRoute> {
  return resolveLandLegRoute(from.lat, from.lng, to.lat, to.lng, resolution, {
    includeGeometry: true,
  });
}

export interface ResolveLandLegOptions {
  /**
   * When true, prefer Google / land-grid geometry for map polylines.
   * Cost comparison keeps this false so only water-crossing legs pay for A*.
   */
  includeGeometry?: boolean;
}

/**
 * Road distance for a land leg.
 * - Water-crossing chords: Google (if configured) → land-grid A* → inflated H3
 * - Dry land: H3 (fast); Google only when geometry is requested
 */
export async function resolveLandLegRoute(
  fromLat: number | null,
  fromLng: number | null,
  toLat: number | null,
  toLng: number | null,
  resolution?: number,
  options?: ResolveLandLegOptions
): Promise<LandLegRoute> {
  if (
    fromLat == null ||
    fromLng == null ||
    toLat == null ||
    toLng == null ||
    !Number.isFinite(fromLat) ||
    !Number.isFinite(fromLng) ||
    !Number.isFinite(toLat) ||
    !Number.isFinite(toLng)
  ) {
    return { distance_km: null, duration_hours: null, source: "h3", coordinates: null };
  }

  const includeGeometry = options?.includeGeometry === true;
  const from = { lat: fromLat, lng: fromLng };
  const to = { lat: toLat, lng: toLng };
  const crossesWater = segmentCrossesWater(from, to);

  const mode = includeGeometry
    ? crossesWater
      ? "geo-water"
      : "geo-dry"
    : crossesWater
      ? "cost-water"
      : "cost-dry";

  const key = cacheKey(fromLat, fromLng, toLat, toLng, mode);
  const cached = routeCache.get(key);
  if (cached) return cached;

  let result: LandLegRoute;

  if (crossesWater) {
    // Only call Google for water-crossing legs (keeps multi-route cost compare fast).
    if (getLandDistanceProvider() === "google") {
      const google = await googleLeg(fromLat, fromLng, toLat, toLng);
      if (google) {
        result = google;
      } else {
        const grid = landGridLeg(from, to);
        if (grid) {
          result = grid;
        } else {
          const inflated = inflateAcrossWater(from, to, resolution);
          if (includeGeometry) {
            inflated.coordinates = landGridGeometryOnly(from, to);
          }
          result = inflated;
        }
      }
    } else {
      const grid = landGridLeg(from, to);
      if (grid) {
        result = grid;
      } else {
        const inflated = inflateAcrossWater(from, to, resolution);
        if (includeGeometry) {
          inflated.coordinates = landGridGeometryOnly(from, to);
        }
        result = inflated;
      }
    }
  } else if (includeGeometry && getLandDistanceProvider() === "google") {
    const google = await googleLeg(fromLat, fromLng, toLat, toLng);
    result = google ?? {
      ...h3Leg(fromLat, fromLng, toLat, toLng, resolution),
      coordinates: [
        [fromLat, fromLng],
        [toLat, toLng],
      ],
    };
  } else if (includeGeometry) {
    result = {
      ...h3Leg(fromLat, fromLng, toLat, toLng, resolution),
      coordinates: [
        [fromLat, fromLng],
        [toLat, toLng],
      ],
    };
  } else {
    result = h3Leg(fromLat, fromLng, toLat, toLng, resolution);
  }

  routeCache.set(key, result);
  return result;
}

export function clearRoadRouteCache(): void {
  routeCache.clear();
}
