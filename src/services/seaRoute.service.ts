/* eslint-disable @typescript-eslint/no-require-imports */
import {
  findNearestWater,
  isOnLand,
  segmentCrossesLand,
  type LatLng,
} from "./landMask.service";
import {
  mergePaths,
  repairLandCrossings,
  routeOnWaterGrid,
  routeWaterSegment,
} from "./waterGridRouter.service";

export type { LatLng };

const searoute = require("searoute-js") as (
  origin: GeoFeature,
  destination: GeoFeature,
  units?: string
) => GeoLineString | null;

interface GeoFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Point"; coordinates: [number, number] };
}

interface GeoLineString {
  geometry?: { coordinates: [number, number][] };
}

function point(p: LatLng): GeoFeature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [p.lng, p.lat] },
  };
}

function toLeaflet(coords: LatLng[]): [number, number][] {
  return coords.map((p) => [p.lat, p.lng]);
}

function searouteMiddle(departure: LatLng, arrival: LatLng): LatLng[] | null {
  // searoute-js prints stray debug numbers via console.log on every call;
  // silence them for the duration of the routing call only.
  const originalLog = console.log;
  console.log = () => {};
  let route: GeoLineString | null;
  try {
    route = searoute(point(departure), point(arrival));
  } finally {
    console.log = originalLog;
  }
  const coords = route?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

/** Keep only open-water nodes from the marine network (coarse land mask). */
function offshoreWaypoints(points: LatLng[]): LatLng[] {
  return points.filter((p) => !isOnLand(p));
}

/** Rebuild a polyline so every segment is water-safe (A* detour when needed). */
function rebuildWaterPath(points: LatLng[]): LatLng[] {
  if (points.length < 2) return points;
  const out: LatLng[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const from = out[out.length - 1];
    const to = points[i];
    if (!segmentCrossesLand(from, to)) {
      out.push(to);
      continue;
    }
    const detour = routeOnWaterGrid(from, to);
    if (detour && detour.length >= 2) {
      for (let j = 1; j < detour.length; j++) out.push(detour[j]);
    } else {
      out.push(to);
    }
  }
  return out;
}

/**
 * Maritime path as Leaflet `[lat, lng]` tuples.
 *
 * 1. Open-sea backbone from searoute-js (offshore nodes only).
 * 2. Each backbone segment validated / detoured with water-grid A*.
 * 3. Port anchors snapped to nearest open water (never stitch inland coords).
 * 4. Final land-crossing repair pass.
 */
export function computeSeaRoute(
  departure: LatLng,
  arrival: LatLng
): [number, number][] | null {
  const middle = searouteMiddle(departure, arrival);
  if (!middle || middle.length < 2) return null;

  // Coarse land polygons treat coasts/estuaries as land. Use only nodes that
  // fall on open water, then A*-connect them. Falls back to full middle if
  // the route never leaves the coastal mask (rare for ocean hops).
  const offshore = offshoreWaypoints(middle);
  let core =
    offshore.length >= 2
      ? rebuildWaterPath(offshore)
      : rebuildWaterPath(middle);

  core = repairLandCrossings(core);
  if (core.length < 2) return null;

  const depAnchor = isOnLand(departure)
    ? findNearestWater(departure) ?? findNearestWater(departure, 4.0, 0.04)
    : departure;
  const arrAnchor = isOnLand(arrival)
    ? findNearestWater(arrival) ?? findNearestWater(arrival, 4.0, 0.04)
    : arrival;

  const segments: LatLng[][] = [core];

  if (depAnchor) {
    const head = routeWaterSegment(depAnchor, core[0]);
    if (head && head.length >= 2) segments.unshift(head);
  }

  if (arrAnchor) {
    const tail = routeWaterSegment(core[core.length - 1], arrAnchor);
    if (tail && tail.length >= 2) segments.push(tail);
  }

  let path = mergePaths(segments);
  for (let pass = 0; pass < 4; pass++) {
    path = repairLandCrossings(path);
    if (!pathHasLandCrossings(path)) break;
  }

  if (path.length < 2) return null;
  return toLeaflet(path);
}

function pathHasLandCrossings(path: LatLng[]): boolean {
  for (let i = 1; i < path.length; i++) {
    if (segmentCrossesLand(path[i - 1], path[i])) return true;
  }
  return false;
}

function roundKm(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Great-circle distance along a polyline (sum of segment haversines). */
export function polylineDistanceKm(points: LatLng[]): number | null {
  if (points.length < 2) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    total += R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  return roundKm(total);
}

/** Maritime route length in km; falls back to great-circle when routing fails. */
export function computeSeaRouteDistanceKm(
  departure: LatLng,
  arrival: LatLng
): number | null {
  const path = computeSeaRoute(departure, arrival);
  if (path && path.length >= 2) {
    const km = polylineDistanceKm(path.map(([lat, lng]) => ({ lat, lng })));
    if (km != null && km > 0) return km;
  }
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(arrival.lat - departure.lat);
  const dLng = toRad(arrival.lng - departure.lng);
  const lat1 = toRad(departure.lat);
  const lat2 = toRad(arrival.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return roundKm(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}
