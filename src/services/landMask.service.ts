import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
export interface LatLng {
  lat: number;
  lng: number;
}

type LandFeature = Feature<Polygon | MultiPolygon>;
type BBox = [number, number, number, number];

interface IndexedLandFeature {
  feature: LandFeature;
  bbox: BBox;
}

/**
 * Two land masks with different trade-offs:
 * - FINE (10m/50m): harbours, bays and airport spits resolve correctly.
 *   Used for land-leg water checks and the land routing grid.
 * - COARSE (110m): tiny vertex counts, orders of magnitude faster
 *   intersection tests. Used by open-sea routing (offshore precision is
 *   irrelevant there and the sea pipeline calls it thousands of times).
 */
let fineIndex: IndexedLandFeature[] | null = null;
let coarseIndex: IndexedLandFeature[] | null = null;

function firstExisting(names: string[]): string | null {
  for (const name of names) {
    const candidates = [
      path.join(__dirname, "../../data", name),
      path.join(process.cwd(), "data", name),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function loadIndex(filePath: string): IndexedLandFeature[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const collection = JSON.parse(raw) as FeatureCollection<Polygon | MultiPolygon>;
  return collection.features.map((feature) => ({
    feature,
    bbox: turf.bbox(feature) as BBox,
  }));
}

/** Load land polygons once at startup (both resolutions). */
export function ensureLandMaskLoaded(): void {
  if (fineIndex && coarseIndex) return;

  const finePath = firstExisting([
    "ne_10m_land.geojson",
    "ne_50m_land.geojson",
    "ne_110m_land.geojson",
  ]);
  if (!finePath) {
    throw new Error("Land polygon data not found (data/ne_*_land.geojson)");
  }
  fineIndex = loadIndex(finePath);

  const coarsePath = firstExisting(["ne_110m_land.geojson"]);
  coarseIndex = coarsePath && coarsePath !== finePath ? loadIndex(coarsePath) : fineIndex;
}

function fine(): IndexedLandFeature[] {
  ensureLandMaskLoaded();
  return fineIndex!;
}

function coarse(): IndexedLandFeature[] {
  ensureLandMaskLoaded();
  return coarseIndex!;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function pointOnAny(point: LatLng, features: IndexedLandFeature[]): boolean {
  const pt = turf.point([point.lng, point.lat]);
  const pointBbox: BBox = [point.lng, point.lat, point.lng, point.lat];
  for (const item of features) {
    if (!bboxesOverlap(pointBbox, item.bbox)) continue;
    if (turf.booleanPointInPolygon(pt, item.feature)) return true;
  }
  return false;
}

/** True when the point lies on land (fine mask — harbours count as water). */
export function isOnLand(point: LatLng): boolean {
  return pointOnAny(point, fine());
}

/** Coarse land check for open-sea routing (110m; estuaries may read as land). */
export function isOnLandCoarse(point: LatLng): boolean {
  return pointOnAny(point, coarse());
}

/**
 * Faster point-in-land check when the caller already narrowed candidate
 * features (e.g. while filling a local routing grid).
 */
export function isOnLandAmong(
  point: LatLng,
  candidates: IndexedLandFeature[]
): boolean {
  return pointOnAny(point, candidates);
}

/** Land features whose bbox overlaps the query bbox (fast prefilter). */
export function landFeaturesNear(bbox: BBox): IndexedLandFeature[] {
  return fine().filter((item) => bboxesOverlap(bbox, item.bbox));
}

function clipIndexToBbox(
  index: IndexedLandFeature[],
  bbox: BBox
): IndexedLandFeature[] {
  const out: IndexedLandFeature[] = [];
  for (const item of index) {
    if (!bboxesOverlap(bbox, item.bbox)) continue;
    try {
      const clipped = turf.bboxClip(item.feature, bbox);
      const geomType = clipped.geometry?.type;
      if (geomType !== "Polygon" && geomType !== "MultiPolygon") continue;
      const coords = clipped.geometry.coordinates;
      if (!coords || coords.length === 0) continue;
      const feature = clipped as LandFeature;
      out.push({ feature, bbox: turf.bbox(feature) as BBox });
    } catch {
      out.push(item);
    }
  }
  return out;
}

/**
 * Fine land features clipped to a bbox. High-res coastlines (10m) have tens
 * of thousands of vertices per polygon — clipping once makes the thousands of
 * point-in-polygon tests needed for a local routing grid tractable.
 */
export function clipLandToBbox(bbox: BBox): IndexedLandFeature[] {
  return clipIndexToBbox(fine(), bbox);
}

/** Coarse variant for the sea-side water grid. */
export function clipCoarseLandToBbox(bbox: BBox): IndexedLandFeature[] {
  return clipIndexToBbox(coarse(), bbox);
}

/**
 * True when the straight segment between two points crosses any land polygon.
 * Coarse mask — used by open-sea routing where offshore speed matters.
 */
export function segmentCrossesLand(from: LatLng, to: LatLng): boolean {
  const line = turf.lineString([
    [from.lng, from.lat],
    [to.lng, to.lat],
  ]);
  const lineBbox = turf.bbox(line) as BBox;
  for (const item of coarse()) {
    if (!bboxesOverlap(lineBbox, item.bbox)) continue;
    if (turf.booleanIntersects(line, item.feature)) return true;
  }
  return false;
}

/**
 * True when the straight segment crosses open water (samples along the chord,
 * fine mask). Used to detect land legs that cut across harbours / bays.
 */
export function segmentCrossesWater(
  from: LatLng,
  to: LatLng,
  samples = 24
): boolean {
  const lineBbox: BBox = [
    Math.min(from.lng, to.lng),
    Math.min(from.lat, to.lat),
    Math.max(from.lng, to.lng),
    Math.max(from.lat, to.lat),
  ];
  const candidates = landFeaturesNear(lineBbox);
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const p: LatLng = {
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
    };
    if (!isOnLandAmong(p, candidates)) return true;
  }
  return false;
}

/**
 * Nearest open-water point around a port (coarse mask, matching sea routing).
 * Inland / estuary ports sit inside coarse land polygons, so we search
 * outward in rings until we hit water.
 */
export function findNearestWater(
  port: LatLng,
  maxRadiusDeg = 2.5,
  stepDeg = 0.05
): LatLng | null {
  if (!isOnLandCoarse(port)) return port;

  const latScale = Math.cos((port.lat * Math.PI) / 180);
  for (let r = stepDeg; r <= maxRadiusDeg; r += stepDeg) {
    const samples = Math.max(16, Math.ceil((2 * Math.PI * r) / stepDeg));
    for (let i = 0; i < samples; i++) {
      const angle = (2 * Math.PI * i) / samples;
      const candidate: LatLng = {
        lat: port.lat + r * Math.cos(angle),
        lng: port.lng + (r * Math.sin(angle)) / Math.max(latScale, 0.2),
      };
      if (!isOnLandCoarse(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Nearest land point around a coastal / offshore coordinate (fine mask,
 * inverse of {@link findNearestWater}).
 */
export function findNearestLand(
  point: LatLng,
  maxRadiusDeg = 2.5,
  stepDeg = 0.05
): LatLng | null {
  if (isOnLand(point)) return point;

  const searchBbox: BBox = [
    point.lng - maxRadiusDeg,
    point.lat - maxRadiusDeg,
    point.lng + maxRadiusDeg,
    point.lat + maxRadiusDeg,
  ];
  const candidates = landFeaturesNear(searchBbox);
  const latScale = Math.cos((point.lat * Math.PI) / 180);
  for (let r = stepDeg; r <= maxRadiusDeg; r += stepDeg) {
    const samples = Math.max(16, Math.ceil((2 * Math.PI * r) / stepDeg));
    for (let i = 0; i < samples; i++) {
      const angle = (2 * Math.PI * i) / samples;
      const candidate: LatLng = {
        lat: point.lat + r * Math.cos(angle),
        lng: point.lng + (r * Math.sin(angle)) / Math.max(latScale, 0.2),
      };
      if (isOnLandAmong(candidate, candidates)) return candidate;
    }
  }
  return null;
}
