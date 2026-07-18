import { AStarFinder, Grid } from "pathfinding";
import type { LatLng } from "./landMask.service";
import {
  clipLandToBbox,
  findNearestLand,
  isOnLand,
  isOnLandAmong,
  segmentCrossesWater,
} from "./landMask.service";

const finder = new AStarFinder({
  allowDiagonal: true,
  dontCrossCorners: true,
});

function bboxAround(a: LatLng, b: LatLng, padDeg: number) {
  return {
    minLat: Math.min(a.lat, b.lat) - padDeg,
    maxLat: Math.max(a.lat, b.lat) + padDeg,
    minLng: Math.min(a.lng, b.lng) - padDeg,
    maxLng: Math.max(a.lng, b.lng) + padDeg,
  };
}

function chooseStepDeg(a: LatLng, b: LatLng): number {
  const dist = Math.hypot(a.lat - b.lat, a.lng - b.lng);
  // Short harbour hops need fine cells to follow narrow spits/causeways
  // (e.g. Palisadoes ~400 m wide). Longer legs coarsen to bound the grid.
  if (dist < 0.3) return 0.004;
  if (dist < 1.5) return 0.02;
  return 0.05;
}

function latLngToGrid(
  point: LatLng,
  bbox: ReturnType<typeof bboxAround>,
  step: number,
  cols: number,
  rows: number
): { x: number; y: number } | null {
  const x = Math.round((point.lng - bbox.minLng) / step);
  const y = Math.round((bbox.maxLat - point.lat) / step);
  if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
  return { x, y };
}

function gridToLatLng(
  x: number,
  y: number,
  bbox: ReturnType<typeof bboxAround>,
  step: number
): LatLng {
  return {
    lat: bbox.maxLat - y * step,
    lng: bbox.minLng + x * step,
  };
}

/**
 * A* over a local land-only grid. Water cells are blocked so land legs cannot
 * cut across harbours / open sea.
 *
 * Endpoints that sit offshore (e.g. a thin coastal spit missing from the
 * coarse land mask) are snapped to nearest land — the returned path stays on
 * land and does not stitch a water chord back to the offshore point.
 */
export function routeOnLandGrid(start: LatLng, end: LatLng): LatLng[] | null {
  const pad = 0.4;
  const startSnap = isOnLand(start) ? start : findNearestLand(start) ?? start;
  const endSnap = isOnLand(end) ? end : findNearestLand(end) ?? end;

  const bbox = bboxAround(startSnap, endSnap, pad);
  const step = chooseStepDeg(startSnap, endSnap);
  const cols = Math.max(8, Math.ceil((bbox.maxLng - bbox.minLng) / step) + 1);
  const rows = Math.max(8, Math.ceil((bbox.maxLat - bbox.minLat) / step) + 1);

  if (cols * rows > 80_000) return null;

  const candidates = clipLandToBbox([
    bbox.minLng,
    bbox.minLat,
    bbox.maxLng,
    bbox.maxLat,
  ]);

  const grid = new Grid(cols, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = gridToLatLng(x, y, bbox, step);
      grid.setWalkableAt(x, y, isOnLandAmong(cell, candidates));
    }
  }

  let startCell = latLngToGrid(startSnap, bbox, step, cols, rows);
  let endCell = latLngToGrid(endSnap, bbox, step, cols, rows);

  if (!startCell || !grid.isWalkableAt(startCell.x, startCell.y)) {
    startCell =
      findNearestWalkable(startSnap, bbox, step, cols, rows, grid) ?? startCell;
  }
  if (!endCell || !grid.isWalkableAt(endCell.x, endCell.y)) {
    endCell =
      findNearestWalkable(endSnap, bbox, step, cols, rows, grid) ?? endCell;
  }
  if (!startCell || !endCell) return null;

  const path = finder.findPath(
    startCell.x,
    startCell.y,
    endCell.x,
    endCell.y,
    grid.clone()
  );
  if (!path.length) return null;

  // Single grid cell: still emit both snapped endpoints.
  if (path.length === 1) {
    return dedupeLatLngs([startSnap, endSnap]);
  }

  const coords = path.map((cell: [number, number]) =>
    gridToLatLng(cell[0], cell[1], bbox, step)
  );
  // Keep snapped land endpoints — do not force offshore hubs back onto the path.
  coords[0] = startSnap;
  coords[coords.length - 1] = endSnap;
  return dedupeLatLngs(coords);
}

function findNearestWalkable(
  target: LatLng,
  bbox: ReturnType<typeof bboxAround>,
  step: number,
  cols: number,
  rows: number,
  grid: Grid
): { x: number; y: number } | null {
  const origin = latLngToGrid(target, bbox, step, cols, rows);
  if (!origin) return null;
  const maxRadius = Math.max(cols, rows);
  for (let r = 1; r < maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (grid.isWalkableAt(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/**
 * Connect two land points without crossing open water. Uses a direct segment
 * when safe, otherwise A* on a local land grid.
 */
export function routeLandSegment(from: LatLng, to: LatLng): LatLng[] | null {
  if (!segmentCrossesWater(from, to)) {
    return dedupeLatLngs([from, to]);
  }
  return routeOnLandGrid(from, to);
}

function dedupeLatLngs(points: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.lat - p.lat) < 1e-6 &&
      Math.abs(prev.lng - p.lng) < 1e-6
    ) {
      continue;
    }
    out.push(p);
  }
  return out;
}
