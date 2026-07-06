import { cellToLatLng } from "h3-js";
import { pool } from "../database";
import type { OrderResponse } from "../models/order.model";
import type {
  OrderRouteCostComparisonResponse,
  RouteCostStatus,
  RouteCostSummaryResponse,
  RouteSegmentCostResponse,
  SegmentCostSource,
  SegmentCostStatus,
  TransporterQuoteRequestItem,
  AffectedRouteRef,
} from "../models/routeCost.model";
import {
  segmentNeedsCostEntry,
  segmentNeedsRecalculation,
} from "../models/routeCost.model";
import { getBookingFeeRate, getLandSpeedKmh, getPffFactor } from "./pricingConfig.service";
import {
  loadRegionsByIds,
  mergeZoneRateWithRegion,
  rateDefaultsConfigured,
} from "./pricingRegion.service";
import type { ZonePricingMode } from "../models/pricingRegion.model";
import { getOrderById, updateOrderRouteSchedule, type OrderContext } from "./order.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";
import { totalPaymentPackageFactor } from "../models/paymentPackage.model";
import { ensurePffRouteSegmentsForOrder } from "./pffRouteUpgrade.service";
import { createUserNotification } from "./notification.service";
import {
  DEFAULT_PREVIEW_MAX_DEPTH,
  previewOrderZoneConnectionsByCoordinates,
} from "./orderZoneConnection.service";
import {
  calculateSegmentCost,
  calculateSegmentDistanceH3,
  deriveSegmentsFromRoute,
  expectedSegmentCountForRoute,
  haversineKm,
  type DerivedSegment,
  type SegmentRate,
} from "./costCalculation.service";
import { resolveLandLegRoute } from "./roadRouting.service";
import {
  ExternalQuoteError,
  fetchExternalQuote,
  isExternalQuoteConfigured,
  type ExternalQuoteRequest,
} from "./externalQuote.service";
import {
  getOrderRouteLockInfo,
  isOrderRouteLocked,
} from "./orderRouteLock.service";

export class RouteCostError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseJsonIntArray(raw: unknown): number[] {
  if (Array.isArray(raw))
    return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (typeof raw === "string") {
    try {
      return parseJsonIntArray(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Stable signature for a route based on its ordered zone ids. Used to carry
 * manually-entered segment costs across a full recalculation, where the
 * `order_routes` rows are dropped and recreated with new ids.
 */
function zoneSignature(zoneIds: number[]): string {
  return zoneIds.join(",");
}

type RouteChain = { zone_ids: number[]; connection_ids: number[] };

/** Serialize route re-sync for one order so concurrent callers don't race on DELETE/INSERT. */
const orderResyncQueues = new Map<number, Promise<unknown>>();

async function withOrderResyncLock<T>(
  orderId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = orderResyncQueues.get(orderId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  orderResyncQueues.set(
    orderId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function chainSignature(chain: RouteChain): string {
  return `${chain.zone_ids.join(",")}|${chain.connection_ids.join(",")}`;
}

function storedRouteSignature(route: {
  zone_ids: unknown;
  connection_ids: unknown;
}): string {
  return chainSignature({
    zone_ids: parseJsonIntArray(route.zone_ids),
    connection_ids: parseJsonIntArray(route.connection_ids),
  });
}

function routeChainsMatch(
  live: RouteChain[],
  stored: Array<{ zone_ids: unknown; connection_ids: unknown }>,
): boolean {
  if (live.length !== stored.length) return false;
  const liveSigs = live.map(chainSignature).sort();
  const storedSigs = stored.map(storedRouteSignature).sort();
  return liveSigs.every((sig, i) => sig === storedSigs[i]);
}

async function fetchLiveRouteChains(
  order: OrderResponse,
): Promise<RouteChain[]> {
  if (
    order.sender_lat == null ||
    order.sender_lng == null ||
    order.destination_lat == null ||
    order.destination_lng == null
  ) {
    return [];
  }

  const preview = await previewOrderZoneConnectionsByCoordinates({
    source_lat: order.sender_lat,
    source_lng: order.sender_lng,
    destination_lat: order.destination_lat,
    destination_lng: order.destination_lng,
    source_name: order.source_name,
    source_address: order.sender_address,
    destination_name: order.receiver_name,
    destination_address: order.destination_address,
    max_depth: DEFAULT_PREVIEW_MAX_DEPTH,
    schedule_at: order.route_schedule_at ?? undefined,
  });

  return preview.possible_connection_chains;
}

async function orderRoutesNeedResync(
  order: OrderResponse,
  liveChains: RouteChain[],
): Promise<boolean> {
  const stored = await pool.query(
    `SELECT zone_ids, connection_ids FROM order_routes WHERE order_id = $1 ORDER BY route_index`,
    [order.id],
  );
  if (stored.rowCount === 0) return true;
  return !routeChainsMatch(liveChains, stored.rows);
}

/**
 * Snapshot every manual segment cost for an order, keyed by
 * `${zoneSignature}::${segment_index}`, so a recalculation can re-apply them
 * even though the underlying route/segment rows are recreated.
 */
async function snapshotManualCosts(
  orderId: number,
): Promise<Map<string, number>> {
  const result = await pool.query(
    `SELECT r.zone_ids, sc.segment_index, sc.manual_cost
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE r.order_id = $1 AND sc.cost_status = 'manual' AND sc.manual_cost IS NOT NULL`,
    [orderId],
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    const sig = zoneSignature(parseJsonIntArray(row.zone_ids));
    map.set(`${sig}::${Number(row.segment_index)}`, Number(row.manual_cost));
  }
  return map;
}

async function loadZoneMetaForIds(zoneIds: number[]): Promise<
  Map<
    number,
    {
      owner_user_id: number;
      transport_mode: string | null;
      zone_name: string;
      resolution: number | null;
      departure_time: string | null;
      arrival_time: string | null;
    }
  >
> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, owner_user_id, transport_mode, zone_name, resolution,
            departure_time, arrival_time
     FROM driver_zones WHERE id = ANY($1::int[])`,
    [zoneIds],
  );
  const map = new Map<
    number,
    {
      owner_user_id: number;
      transport_mode: string | null;
      zone_name: string;
      resolution: number | null;
      departure_time: string | null;
      arrival_time: string | null;
    }
  >();
  for (const row of result.rows) {
    map.set(Number(row.id), {
      owner_user_id: Number(row.owner_user_id),
      transport_mode:
        row.transport_mode == null ? null : String(row.transport_mode),
      zone_name: String(row.zone_name ?? ""),
      resolution:
        row.resolution == null || !Number.isFinite(Number(row.resolution))
          ? null
          : Number(row.resolution),
      departure_time:
        row.departure_time == null ? null : String(row.departure_time),
      arrival_time: row.arrival_time == null ? null : String(row.arrival_time),
    });
  }
  return map;
}

async function loadZoneCentroids(
  zoneIds: number[],
): Promise<
  Map<number, { lat: number; lng: number; transport_method: string | null }>
> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT z.id, z.transport_mode,
            COALESCE(
              (SELECT elem FROM jsonb_array_elements_text(z.h3_cells) WITH ORDINALITY AS t(elem, ord) WHERE ord = 1 LIMIT 1),
              NULL
            ) AS sample_cell
     FROM driver_zones z
     WHERE z.id = ANY($1::int[])`,
    [zoneIds],
  );
  const map = new Map<
    number,
    { lat: number; lng: number; transport_method: string | null }
  >();
  for (const row of result.rows) {
    const cell = row.sample_cell != null ? String(row.sample_cell) : null;
    if (!cell) continue;
    try {
      const [lat, lng] = cellToLatLng(cell);
      map.set(Number(row.id), {
        lat,
        lng,
        transport_method:
          row.transport_mode == null ? null : String(row.transport_mode),
      });
    } catch {
      /* skip */
    }
  }
  return map;
}

/**
 * Load per-zone pricing rules. Merges zone overrides with regional defaults
 * when pricing_mode is "system". Manual-mode zones are included with their
 * mode flag but may have null rates.
 */
interface ZonePricingEntry {
  pricing_mode: ZonePricingMode;
  pricing_region_name: string | null;
  effective_base_fee: number | null;
  effective_cost_per_km: number | null;
  effective_cost_per_hour: number | null;
  rate: SegmentRate | null;
}

function nodeIdToZoneId(nodeId: string): number | null {
  const trimmed = nodeId.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (trimmed !== String(n)) return null;
  return n;
}

/**
 * The driver zone a segment cost row prices (owner's zone on this leg).
 * Matches `deriveSegmentsFromRoute` — the priced zone is the leg's destination
 * zone when numeric, otherwise the zone at `segment_index` on the route chain.
 */
function pricedZoneIdForSegment(row: {
  from_node_id: unknown;
  to_node_id: unknown;
  segment_index: unknown;
  zone_ids: unknown;
}): number | null {
  const toZid = nodeIdToZoneId(String(row.to_node_id));
  if (toZid != null) return toZid;
  const zoneIds = parseJsonIntArray(row.zone_ids);
  const idx = Number(row.segment_index);
  if (Number.isInteger(idx) && idx >= 0 && idx < zoneIds.length) {
    return zoneIds[idx] ?? null;
  }
  return null;
}

function quoteDedupKey(
  orderId: number,
  transporterId: number,
  pricedZoneId: number,
): string {
  return `${orderId}:${transporterId}:${pricedZoneId}`;
}

/** All pending segment-cost rows on an order for the same transporter + priced zone. */
async function findSiblingSegmentRows(
  orderId: number,
  transporterId: number,
  pricedZoneId: number,
  statuses: SegmentCostStatus[] = ["requested", "missing"],
): Promise<
  Array<
    Record<string, unknown> & {
      route_id: number;
      route_label: string;
      zone_ids: unknown;
    }
  >
> {
  const result = await pool.query(
    `SELECT sc.*, r.id AS route_id, r.route_label, r.zone_ids, r.connection_ids, r.order_id
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE r.order_id = $1
       AND sc.transporter_id = $2
       AND sc.cost_status = ANY($3::text[])`,
    [orderId, transporterId, statuses],
  );
  return result.rows.filter((row) => {
    const zid = pricedZoneIdForSegment(row);
    return zid === pricedZoneId;
  }) as Array<
    Record<string, unknown> & {
      route_id: number;
      route_label: string;
      zone_ids: unknown;
    }
  >;
}

async function recalculateRouteSummaries(
  routeIds: Iterable<number>,
): Promise<void> {
  const seen = new Set<number>();
  for (const routeId of routeIds) {
    if (seen.has(routeId)) continue;
    seen.add(routeId);
    await recalculateRouteSummary(routeId);
  }
}

async function loadZonePricing(
  zoneIds: number[],
): Promise<Map<number, ZonePricingEntry>> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT dz.id, dz.currency, dz.pricing_mode, dz.pricing_region_id,
            dz.base_fee, dz.cost_per_km, dz.cost_per_hour,
            pr.name AS pricing_region_name
     FROM driver_zones dz
     LEFT JOIN pricing_regions pr ON pr.id = dz.pricing_region_id
     WHERE dz.id = ANY($1::int[])`,
    [zoneIds],
  );
  const num = (v: unknown): number | null =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v);

  const regionIds = [
    ...new Set(
      result.rows
        .map((r) =>
          r.pricing_region_id == null ? null : Number(r.pricing_region_id),
        )
        .filter((id): id is number => id != null),
    ),
  ];
  const regions = await loadRegionsByIds(regionIds);

  const map = new Map<number, ZonePricingEntry>();
  for (const row of result.rows) {
    const pricingMode: ZonePricingMode =
      String(row.pricing_mode ?? "system") === "manual" ? "manual" : "system";
    const regionId =
      row.pricing_region_id == null ? null : Number(row.pricing_region_id);
    const merged = mergeZoneRateWithRegion(
      {
        base_fee: num(row.base_fee),
        cost_per_km: num(row.cost_per_km),
        cost_per_hour: num(row.cost_per_hour),
        currency: String(row.currency ?? "CAD"),
      },
      regionId != null ? (regions.get(regionId) ?? null) : null,
    );
    const rate: SegmentRate = {
      currency: merged.currency,
      base_fee: merged.base_fee,
      cost_per_km: merged.cost_per_km,
      cost_per_hour: merged.cost_per_hour,
    };
    const configured = rateDefaultsConfigured(merged);
    map.set(Number(row.id), {
      pricing_mode: pricingMode,
      pricing_region_name:
        row.pricing_region_name == null
          ? null
          : String(row.pricing_region_name),
      effective_base_fee: merged.base_fee,
      effective_cost_per_km: merged.cost_per_km,
      effective_cost_per_hour: merged.cost_per_hour,
      rate: configured ? rate : null,
    });
  }
  return map;
}

/**
 * For air/sea zones, the leg is a line between two terminals. Precompute the
 * great-circle distance (km) between each such zone's departure and arrival
 * hubs so the segment can be priced per km.
 */
async function loadZoneLineDistances(
  zoneIds: number[],
): Promise<Map<number, number>> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, transport_mode,
            departure_hub_lat, departure_hub_lng, arrival_hub_lat, arrival_hub_lng
     FROM driver_zones WHERE id = ANY($1::int[])`,
    [zoneIds],
  );
  const map = new Map<number, number>();
  for (const row of result.rows) {
    const mode = String(row.transport_mode ?? "land");
    if (mode !== "air" && mode !== "sea") continue;
    const km = haversineKm(
      row.departure_hub_lat == null ? null : Number(row.departure_hub_lat),
      row.departure_hub_lng == null ? null : Number(row.departure_hub_lng),
      row.arrival_hub_lat == null ? null : Number(row.arrival_hub_lat),
      row.arrival_hub_lng == null ? null : Number(row.arrival_hub_lng),
    );
    if (km != null) map.set(Number(row.id), km);
  }
  return map;
}

interface LatLng {
  lat: number;
  lng: number;
}

/** Centroid of a connection's transfer (border-crossing) cells. */
function transferPointFromCells(cells: string[]): LatLng | null {
  if (!cells || cells.length === 0) return null;
  const sample = cells.slice(0, 20);
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const c of sample) {
    try {
      const [la, lo] = cellToLatLng(c);
      lat += la;
      lng += lo;
      n++;
    } catch {
      /* skip invalid cell */
    }
  }
  if (n === 0) return null;
  return { lat: lat / n, lng: lng / n };
}

/**
 * Load the persisted zone connections used by a route so we know the actual
 * border-crossing cells where the package hands off between zones. Those are
 * the entry/exit points used to count cells traversed within a land zone.
 */
async function loadConnectionsByIds(
  ids: number[],
): Promise<
  Map<
    number,
    { zone_a_id: number; zone_b_id: number; transfer_cells: string[] }
  >
> {
  const map = new Map<
    number,
    { zone_a_id: number; zone_b_id: number; transfer_cells: string[] }
  >();
  if (ids.length === 0) return map;
  const result = await pool.query(
    `SELECT id, zone_a_id, zone_b_id, transfer_cells FROM zone_connections WHERE id = ANY($1::int[])`,
    [ids],
  );
  for (const row of result.rows) {
    let cells: string[] = [];
    const raw = row.transfer_cells;
    if (Array.isArray(raw)) cells = raw.map(String);
    else if (typeof raw === "string") {
      try {
        cells = JSON.parse(raw);
      } catch {
        cells = [];
      }
    }
    map.set(Number(row.id), {
      zone_a_id: Number(row.zone_a_id),
      zone_b_id: Number(row.zone_b_id),
      transfer_cells: cells,
    });
  }
  return map;
}

/**
 * Compute distance for each segment:
 *  - Land zones: Google Directions road km when configured, else H3; sums per zone leg.
 *  - Air/sea zones: great-circle hub distance.
 */
async function computeSegmentDistances(
  zoneIds: number[],
  connectionIds: number[],
  order: OrderResponse,
  zoneMeta: Map<
    number,
    { transport_mode: string | null; resolution: number | null }
  >,
  zoneCoords: Map<number, { lat: number; lng: number }>,
  zoneLineKm: Map<number, number>,
  connectionsById: Map<
    number,
    { zone_a_id: number; zone_b_id: number; transfer_cells: string[] }
  >,
  segments: DerivedSegment[],
): Promise<
  Map<
    number,
    {
      distance_h3_cells: number | null;
      distance_km: number | null;
      duration_hours: number | null;
    }
  >
> {
  const transferAt = (i: number): LatLng | null => {
    const connId = connectionIds[i];
    if (connId != null) {
      const conn = connectionsById.get(connId);
      const tp = conn ? transferPointFromCells(conn.transfer_cells) : null;
      if (tp) return tp;
    }
    // Fallback: midpoint of the two zone centroids.
    const a = zoneCoords.get(zoneIds[i]);
    const b = zoneCoords.get(zoneIds[i + 1]);
    if (a && b) return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    return null;
  };

  const sender: LatLng | null =
    order.sender_lat != null && order.sender_lng != null
      ? { lat: order.sender_lat, lng: order.sender_lng }
      : null;
  const receiver: LatLng | null =
    order.destination_lat != null && order.destination_lng != null
      ? { lat: order.destination_lat, lng: order.destination_lng }
      : null;

  const perZoneForward = new Map<
    number,
    { cells: number | null; km: number | null; hours: number | null }
  >();
  const perZoneReverse = new Map<
    number,
    { cells: number | null; km: number | null; hours: number | null }
  >();

  for (let i = 0; i < zoneIds.length; i++) {
    const zoneId = zoneIds[i];
    const meta = zoneMeta.get(zoneId);
    const mode = meta?.transport_mode ?? "land";
    if (mode === "air" || mode === "sea") {
      const lineDist = {
        cells: null,
        km: zoneLineKm.get(zoneId) ?? null,
        hours: null,
      };
      perZoneForward.set(zoneId, lineDist);
      perZoneReverse.set(zoneId, lineDist);
      continue;
    }
    const centroid = zoneCoords.get(zoneId) ?? null;
    const forwardEntry = (i === 0 ? sender : transferAt(i - 1)) ?? centroid;
    const forwardExit =
      (i === zoneIds.length - 1 ? receiver : transferAt(i)) ?? centroid;
    const reverseEntry = (i === zoneIds.length - 1 ? receiver : transferAt(i)) ?? centroid;
    const reverseExit = (i === 0 ? sender : transferAt(i - 1)) ?? centroid;

    const forwardDist = await resolveZoneLegDistance(
      forwardEntry,
      forwardExit,
      meta?.resolution ?? undefined,
    );
    perZoneForward.set(zoneId, forwardDist);

    const reverseDist = await resolveZoneLegDistance(
      reverseEntry,
      reverseExit,
      meta?.resolution ?? undefined,
    );
    perZoneReverse.set(zoneId, reverseDist);
  }

  const bySegment = new Map<
    number,
    {
      distance_h3_cells: number | null;
      distance_km: number | null;
      duration_hours: number | null;
    }
  >();
  for (const seg of segments) {
    const line =
      seg.transport_method === "air" || seg.transport_method === "sea";
    const perZone =
      seg.leg_phase === "payment" ? perZoneReverse : perZoneForward;
    let cells = 0;
    let km = 0;
    let hours = 0;
    let haveCells = false;
    let haveKm = false;
    let haveHours = false;
    for (const zid of seg.zone_ids) {
      const d = perZone.get(zid);
      if (!d) continue;
      if (d.cells != null) {
        cells += d.cells;
        haveCells = true;
      }
      if (d.km != null) {
        km += d.km;
        haveKm = true;
      }
      if (d.hours != null) {
        hours += d.hours;
        haveHours = true;
      }
    }
    bySegment.set(seg.segment_index, {
      distance_h3_cells: line ? null : haveCells ? cells : null,
      distance_km: haveKm ? Math.round(km * 100) / 100 : null,
      duration_hours: haveHours ? Math.round(hours * 100) / 100 : null,
    });
  }
  return bySegment;
}

async function resolveZoneLegDistance(
  entry: LatLng | null,
  exit: LatLng | null,
  resolution?: number,
): Promise<{
  cells: number | null;
  km: number | null;
  hours: number | null;
}> {
  if (!entry || !exit) {
    return { cells: null, km: null, hours: null };
  }
  const route = await resolveLandLegRoute(
    entry.lat,
    entry.lng,
    exit.lat,
    exit.lng,
    resolution,
  );
  let cells: number | null = null;
  if (route.source === "h3") {
    const d = calculateSegmentDistanceH3(
      entry.lat,
      entry.lng,
      exit.lat,
      exit.lng,
      resolution,
    );
    cells = d.distance_h3_cells;
  }
  return {
    cells,
    km: route.distance_km,
    hours: route.duration_hours,
  };
}

async function loadTransporterNames(
  ids: number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, full_name FROM users WHERE id = ANY($1::int[])`,
    [ids],
  );
  const map = new Map<number, string>();
  for (const row of result.rows) {
    map.set(Number(row.id), String(row.full_name ?? ""));
  }
  return map;
}

function nodeLabel(nodeId: string, zoneNames: Map<number, string>): string {
  if (nodeId === "sender") return "Sender";
  if (nodeId === "receiver") return "Receiver";
  const zid = Number(nodeId);
  if (Number.isFinite(zid)) {
    const name = zoneNames.get(zid);
    return name ? `Zone: ${name}` : `Zone #${zid}`;
  }
  return nodeId;
}

function nodeCoords(
  nodeId: string,
  order: OrderResponse,
  zoneCoords: Map<number, { lat: number; lng: number }>,
): { lat: number | null; lng: number | null } {
  if (nodeId === "sender") {
    return { lat: order.sender_lat, lng: order.sender_lng };
  }
  if (nodeId === "receiver") {
    return { lat: order.destination_lat, lng: order.destination_lng };
  }
  const zid = Number(nodeId);
  if (Number.isFinite(zid)) {
    const z = zoneCoords.get(zid);
    if (z) return { lat: z.lat, lng: z.lng };
  }
  return { lat: null, lng: null };
}

function summarizeRouteStatus(
  segments: { cost_status: SegmentCostStatus; final_cost: number | null }[],
): {
  status: RouteCostStatus;
  missing_segment_count: number;
  requested_segment_count: number;
  total_final_cost: number | null;
} {
  const missing = segments.filter((s) => s.cost_status === "missing").length;
  const requested = segments.filter(
    (s) => s.cost_status === "requested",
  ).length;
  const pending = missing + requested;
  const withFinal = segments.filter((s) => s.final_cost != null);
  const total =
    withFinal.length > 0
      ? Math.round(
          withFinal.reduce((sum, s) => sum + (s.final_cost ?? 0), 0) * 100,
        ) / 100
      : null;

  let status: RouteCostStatus = "complete";
  if (pending === segments.length) status = "missing";
  else if (pending > 0) status = "partial";

  return {
    status,
    missing_segment_count: missing,
    requested_segment_count: requested,
    total_final_cost: total,
  };
}

/** Drivers may only see costs for legs they operate — not other transporters on the same route. */
function scopeRouteSummaryForDriver(
  summary: RouteCostSummaryResponse,
  driverUserId: number,
): RouteCostSummaryResponse {
  const segments = summary.segments.filter(
    (s) => s.transporter_id === driverUserId,
  );
  const {
    status,
    missing_segment_count,
    requested_segment_count,
    total_final_cost,
  } = summarizeRouteStatus(segments);

  let totalCalculated = 0;
  let calculatedCount = 0;
  let totalManual = 0;
  let manualCount = 0;
  for (const seg of segments) {
    if (seg.calculated_cost != null) {
      totalCalculated += seg.calculated_cost;
      calculatedCount++;
    }
    if (seg.manual_cost != null) {
      totalManual += seg.manual_cost;
      manualCount++;
    }
  }

  const transporterNames = [
    ...new Set(segments.map((s) => s.transporter_name).filter(Boolean)),
  ];

  return {
    ...summary,
    transporters: transporterNames,
    segment_count: segments.length,
    total_calculated_cost:
      calculatedCount > 0 ? Math.round(totalCalculated * 100) / 100 : null,
    total_manual_cost:
      manualCount > 0 ? Math.round(totalManual * 100) / 100 : null,
    total_final_cost,
    missing_segment_count,
    requested_segment_count,
    status,
    segments,
  };
}

/**
 * Sync persisted routes from Milestone 4 chain enumeration for an order.
 */
export async function syncOrderRoutesFromPreview(
  order: OrderResponse,
  liveChains?: RouteChain[],
): Promise<number[]> {
  if (await isOrderRouteLocked(order.id)) {
    const existing = await pool.query(
      `SELECT id FROM order_routes WHERE order_id = $1 ORDER BY route_index`,
      [order.id],
    );
    return existing.rows.map((row) => Number(row.id));
  }

  const chains = liveChains ?? (await fetchLiveRouteChains(order));
  const routeIds: number[] = [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM order_routes WHERE order_id = $1`, [
      order.id,
    ]);

    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i];
      const zoneMeta = await loadZoneMetaForIds(chain.zone_ids);
      const transporterIds = chain.zone_ids
        .map((zid) => zoneMeta.get(zid)?.owner_user_id)
        .filter((id): id is number => id != null);
      const uniqueTransporters = Array.from(new Set(transporterIds));

      const insert = await client.query(
        `INSERT INTO order_routes
           (order_id, route_label, route_index, zone_ids, connection_ids, transporter_ids, is_complete)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, TRUE)
         RETURNING id`,
        [
          order.id,
          `Route ${i + 1}`,
          i,
          JSON.stringify(chain.zone_ids),
          JSON.stringify(chain.connection_ids),
          JSON.stringify(uniqueTransporters),
        ],
      );
      routeIds.push(Number(insert.rows[0].id));
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return routeIds;
}

async function driverHasOrderSegmentAccess(
  orderId: number,
  driverUserId: number,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE r.order_id = $1 AND sc.transporter_id = $2
     LIMIT 1`,
    [orderId, driverUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function getOrderForCostAccess(
  orderId: number,
  ctx: OrderContext,
): Promise<OrderResponse> {
  if (ctx.role === "driver") {
    const assigned = await getOrderById(orderId, ctx);
    if (assigned) return assigned;
    if (await driverHasOrderSegmentAccess(orderId, ctx.userId)) {
      const order = await getOrderById(orderId, {
        userId: ctx.userId,
        role: "admin",
      });
      if (!order) throw new RouteCostError("Order not found", 404);
      return order;
    }
    throw new RouteCostError("Order not found", 404);
  }

  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteCostError("Order not found", 404);
  return order;
}

async function assertRouteAccess(
  routeId: number,
  ctx: OrderContext,
): Promise<{ order: OrderResponse; route: Record<string, unknown> }> {
  const result = await pool.query(
    `SELECT r.*, o.sender_user_id, o.receiver_user_id
     FROM order_routes r
     JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1`,
    [routeId],
  );
  if (result.rowCount === 0) throw new RouteCostError("Route not found", 404);
  const row = result.rows[0];

  const senderId = Number(row.sender_user_id);
  const receiverId = Number(row.receiver_user_id);
  const transporterIds = parseJsonIntArray(row.transporter_ids);

  if (ctx.role === "admin") {
    /* ok */
  } else if (ctx.role === "sender" && ctx.userId === senderId) {
    /* ok */
  } else if (ctx.role === "receiver" && ctx.userId === receiverId) {
    /* ok */
  } else if (ctx.role === "driver" && transporterIds.includes(ctx.userId)) {
    /* ok */
  } else {
    throw new RouteCostError("Forbidden", 403);
  }

  const order = await getOrderForCostAccess(Number(row.order_id), ctx);
  if (!order) throw new RouteCostError("Order not found", 404);
  return { order, route: row };
}

export async function calculateRouteCost(
  routeId: number,
  ctx: OrderContext,
  preservedManualByZoneSig?: Map<string, number>,
): Promise<RouteCostSummaryResponse> {
  const { order, route } = await assertRouteAccess(routeId, ctx);
  if (route.is_complete === false) {
    throw new RouteCostError("Cannot calculate cost for an incomplete route", 400);
  }
  const zoneIds = parseJsonIntArray(route.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIds);
  const zoneCoords = await loadZoneCentroids(zoneIds);
  const zonePricing = await loadZonePricing(zoneIds);
  const zoneLineDistances = await loadZoneLineDistances(zoneIds);
  const connectionIds = parseJsonIntArray(route.connection_ids);
  const connectionsById = await loadConnectionsByIds(connectionIds);
  const isPff = isPffPaymentMethod(order.payment_method);
  const segments = deriveSegmentsFromRoute(zoneIds, zoneMeta, isPff);
  const pffFactor = isPff ? await getPffFactor() : 0;
  const segmentDistances = await computeSegmentDistances(
    zoneIds,
    connectionIds,
    order,
    zoneMeta,
    zoneCoords,
    zoneLineDistances,
    connectionsById,
    segments,
  );
  const sig = zoneSignature(zoneIds);

  // Preserve any manual cost a user already entered so a recalculation does
  // not silently wipe it. Keyed by segment_index, which is stable for a route.
  const preservedManual = new Map<
    number,
    { cost: number; source: "manual" | "external" }
  >();
  const preservedRequested = new Set<number>();
  const existingSegs = await pool.query(
    `SELECT segment_index, manual_cost, cost_source, cost_status FROM route_segment_costs
     WHERE route_id = $1`,
    [routeId],
  );
  for (const row of existingSegs.rows) {
    const idx = Number(row.segment_index);
    if (String(row.cost_status) === "manual" && row.manual_cost != null) {
      const source =
        String(row.cost_source) === "external" ? "external" : "manual";
      preservedManual.set(idx, {
        cost: Number(row.manual_cost),
        source,
      });
    } else if (String(row.cost_status) === "requested") {
      preservedRequested.add(idx);
    }
  }
  // Manual costs snapshotted before a full-order recalc (route ids changed)
  // are keyed by zone signature; merge them in for this route.
  if (preservedManualByZoneSig) {
    for (const seg of segments) {
      const carried = preservedManualByZoneSig.get(
        `${sig}::${seg.segment_index}`,
      );
      if (carried != null) {
        preservedManual.set(seg.segment_index, {
          cost: carried,
          source: "manual",
        });
      }
    }
  }

  await pool.query(`DELETE FROM route_segment_costs WHERE route_id = $1`, [
    routeId,
  ]);

  const segmentRows: RouteSegmentCostResponse[] = [];
  let totalCalculated = 0;
  let totalManual = 0;
  let calculatedCount = 0;
  let manualCount = 0;

  const bookingFeeRate = await getBookingFeeRate();
  const landSpeedKmh = await getLandSpeedKmh();

  for (const seg of segments) {
    const zoneId = seg.from_zone_id;
    const zoneInfo = zoneId != null ? zoneMeta.get(zoneId) : null;
    const pricingEntry =
      zoneId != null ? (zonePricing.get(zoneId) ?? null) : null;
    const rate = pricingEntry?.rate ?? null;
    const lineDistanceKm =
      zoneId != null ? (zoneLineDistances.get(zoneId) ?? null) : null;
    const paymentPackageFactor =
      seg.leg_phase === "payment"
        ? totalPaymentPackageFactor(order.payment_packages ?? [])
        : undefined;
    const cost = calculateSegmentCost({
      segment: seg,
      order,
      rate,
      zoneCoords,
      lineDistanceKm,
      departureTime: zoneInfo?.departure_time ?? null,
      arrivalTime: zoneInfo?.arrival_time ?? null,
      distanceOverride: segmentDistances.get(seg.segment_index),
      bookingFeeRate,
      landSpeedKmh,
      pricingMode: pricingEntry?.pricing_mode ?? "system",
      packageFactor: paymentPackageFactor,
    });

    const preserved = preservedManual.get(seg.segment_index);
    if (preserved != null) {
      cost.manual_cost = preserved.cost;
      cost.final_cost = preserved.cost;
      cost.cost_status = "manual";
      cost.cost_source = preserved.source;
    } else if (preservedRequested.has(seg.segment_index)) {
      cost.calculated_cost = null;
      cost.manual_cost = null;
      cost.final_cost = null;
      cost.base_fee = null;
      cost.distance_cost = null;
      cost.waiting_cost = null;
      cost.booking_fee = null;
      cost.cost_status = "requested";
      cost.cost_source = null;
      cost.calculation_breakdown = null;
    } else if (seg.leg_phase === "payment" && isPff && pffFactor >= 0) {
      const scale = pffFactor;
      if (cost.calculated_cost != null) {
        cost.calculated_cost = Math.round(cost.calculated_cost * scale * 100) / 100;
      }
      if (cost.manual_cost != null) {
        cost.manual_cost = Math.round(cost.manual_cost * scale * 100) / 100;
      }
      if (cost.final_cost != null) {
        cost.final_cost = Math.round(cost.final_cost * scale * 100) / 100;
      }
      if (cost.calculation_breakdown) {
        cost.calculation_breakdown = {
          ...cost.calculation_breakdown,
          total_cost: cost.final_cost ?? cost.calculation_breakdown.total_cost,
        };
      }
    }

    if (cost.cost_status === "calculated" && cost.calculated_cost != null) {
      totalCalculated += cost.calculated_cost;
      calculatedCount++;
    } else if (cost.cost_status === "manual" && cost.manual_cost != null) {
      totalManual += cost.manual_cost;
      manualCount++;
    }

    const insert = await pool.query(
      `INSERT INTO route_segment_costs
         (route_id, segment_index, transporter_id, from_node_id, to_node_id,
          transport_method, leg_phase, handoff_role, package_weight, package_volume,
          distance_h3_cells, distance_km, time_hours, package_factor,
          base_fee, weight_cost, volume_cost, distance_cost, waiting_cost, booking_fee,
          time_factor_amount, calculated_cost, manual_cost, final_cost, cost_status, cost_source, currency, calculation_breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb)
       RETURNING id`,
      [
        routeId,
        seg.segment_index,
        seg.transporter_id,
        seg.from_node_id,
        seg.to_node_id,
        seg.transport_method,
        seg.leg_phase ?? null,
        seg.handoff_role ?? null,
        null,
        null,
        cost.distance_h3_cells,
        cost.distance_km,
        cost.time_hours,
        cost.package_factor,
        cost.base_fee,
        null,
        null,
        cost.distance_cost,
        cost.waiting_cost,
        cost.booking_fee,
        null,
        cost.calculated_cost,
        cost.manual_cost,
        cost.final_cost,
        cost.cost_status,
        cost.cost_source,
        cost.currency,
        cost.calculation_breakdown
          ? JSON.stringify(cost.calculation_breakdown)
          : null,
      ],
    );

    segmentRows.push(
      await buildSegmentResponse(
        insert.rows[0],
        zoneMeta,
        await loadTransporterNames([seg.transporter_id]),
        zonePricing,
      ),
    );
  }

  const summaryInput = segmentRows.map((s) => ({
    cost_status: s.cost_status,
    final_cost: s.final_cost,
  }));
  const {
    status,
    missing_segment_count,
    requested_segment_count,
    total_final_cost,
  } = summarizeRouteStatus(summaryInput);

  await pool.query(`DELETE FROM route_cost_summaries WHERE route_id = $1`, [
    routeId,
  ]);
  await pool.query(
    `INSERT INTO route_cost_summaries
       (route_id, order_id, total_calculated_cost, total_manual_cost, total_final_cost,
        missing_segment_count, requested_segment_count, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      routeId,
      order.id,
      calculatedCount > 0 ? Math.round(totalCalculated * 100) / 100 : null,
      manualCount > 0 ? Math.round(totalManual * 100) / 100 : null,
      total_final_cost,
      missing_segment_count,
      requested_segment_count,
      segmentRows[0]?.currency ?? "CAD",
      status,
    ],
  );

  return buildRouteSummaryResponse(route, order, segmentRows);
}

async function buildSegmentResponse(
  row: Record<string, unknown>,
  zoneMeta: Map<number, { zone_name: string }>,
  transporterNames: Map<number, string>,
  zonePricing?: Map<number, ZonePricingEntry>,
): Promise<RouteSegmentCostResponse> {
  const zoneNames = new Map<number, string>();
  zoneMeta.forEach((v, k) => zoneNames.set(k, v.zone_name));

  let breakdown = null;
  if (row.calculation_breakdown) {
    breakdown =
      typeof row.calculation_breakdown === "string"
        ? JSON.parse(row.calculation_breakdown)
        : row.calculation_breakdown;
  }

  const tid = Number(row.transporter_id);
  const zoneId =
    nodeIdToZoneId(String(row.from_node_id)) ??
    nodeIdToZoneId(String(row.to_node_id));
  const pricing = zoneId != null ? (zonePricing?.get(zoneId) ?? null) : null;
  const legPhaseRaw = row.leg_phase;
  const leg_phase =
    legPhaseRaw === "payment" || legPhaseRaw === "goods" ? legPhaseRaw : null;
  const handoffRaw = row.handoff_role;
  const handoff_role =
    handoffRaw === "payment_delivery" || handoffRaw === "goods_pickup"
      ? handoffRaw
      : null;
  return {
    segment_id: Number(row.id),
    segment_index: Number(row.segment_index),
    transporter_id: tid,
    transporter_name: transporterNames.get(tid) ?? `Transporter #${tid}`,
    from_node_id: String(row.from_node_id),
    from_label: nodeLabel(String(row.from_node_id), zoneNames),
    to_node_id: String(row.to_node_id),
    to_label: nodeLabel(String(row.to_node_id), zoneNames),
    leg_phase,
    handoff_role,
    transport_method: String(row.transport_method),
    zone_id: zoneId,
    zone_pricing_mode: pricing?.pricing_mode ?? null,
    pricing_region_name: pricing?.pricing_region_name ?? null,
    effective_base_fee: pricing?.effective_base_fee ?? null,
    effective_cost_per_km: pricing?.effective_cost_per_km ?? null,
    effective_cost_per_hour: pricing?.effective_cost_per_hour ?? null,
    distance_h3_cells:
      row.distance_h3_cells != null ? Number(row.distance_h3_cells) : null,
    distance_km: row.distance_km != null ? Number(row.distance_km) : null,
    time_hours: row.time_hours != null ? Number(row.time_hours) : null,
    package_factor:
      row.package_factor != null ? Number(row.package_factor) : null,
    base_fee: row.base_fee != null ? Number(row.base_fee) : null,
    distance_cost: row.distance_cost != null ? Number(row.distance_cost) : null,
    waiting_cost: row.waiting_cost != null ? Number(row.waiting_cost) : null,
    booking_fee: row.booking_fee != null ? Number(row.booking_fee) : null,
    weight_cost: null,
    volume_cost: null,
    time_factor_amount: null,
    calculated_cost:
      row.calculated_cost != null ? Number(row.calculated_cost) : null,
    manual_cost: row.manual_cost != null ? Number(row.manual_cost) : null,
    final_cost: row.final_cost != null ? Number(row.final_cost) : null,
    cost_status: String(row.cost_status) as SegmentCostStatus,
    cost_source:
      row.cost_source == null
        ? null
        : (String(row.cost_source) as SegmentCostSource),
    currency: String(row.currency ?? "CAD"),
    breakdown,
  };
}

async function buildRouteSummaryResponse(
  route: Record<string, unknown>,
  order: OrderResponse,
  segments: RouteSegmentCostResponse[],
): Promise<RouteCostSummaryResponse> {
  const transporterIds = parseJsonIntArray(route.transporter_ids);
  const names = await loadTransporterNames(transporterIds);
  const transporters = transporterIds.map(
    (id) => names.get(id) ?? `Transporter #${id}`,
  );
  const {
    status,
    missing_segment_count,
    requested_segment_count,
    total_final_cost,
  } = summarizeRouteStatus(segments);

  const summaryResult = await pool.query(
    `SELECT * FROM route_cost_summaries WHERE route_id = $1`,
    [Number(route.id)],
  );
  const summary = summaryResult.rows[0];

  return {
    route_id: Number(route.id),
    order_id: order.id,
    route_label: String(route.route_label ?? ""),
    transporters,
    segment_count: segments.length,
    total_calculated_cost:
      summary?.total_calculated_cost != null
        ? Number(summary.total_calculated_cost)
        : null,
    total_manual_cost:
      summary?.total_manual_cost != null
        ? Number(summary.total_manual_cost)
        : null,
    total_final_cost,
    missing_segment_count,
    requested_segment_count,
    currency: String(summary?.currency ?? segments[0]?.currency ?? "CAD"),
    status,
    segments,
  };
}

export async function getRouteCostSummary(
  routeId: number,
  ctx: OrderContext,
): Promise<RouteCostSummaryResponse> {
  const { order, route } = await assertRouteAccess(routeId, ctx);
  if (route.is_complete === false) {
    throw new RouteCostError("Cannot load cost for an incomplete route", 400);
  }

  const segResult = await pool.query(
    `SELECT * FROM route_segment_costs WHERE route_id = $1 ORDER BY segment_index`,
    [routeId],
  );
  let segmentRows = segResult.rows;

  const zoneIds = parseJsonIntArray(route.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIds);

  const zonePricing = await loadZonePricing(zoneIds);

  // Recompute when there are no rows yet, when any segment is `missing` (rates
  // newly configured), or when segmentation is stale. `requested` (e.g. air
  // awaiting quote) is stable and must NOT trigger recalc on every read.
  const isPff = isPffPaymentMethod(order.payment_method);
  const expectedSegmentCount = expectedSegmentCountForRoute(
    zoneIds.length,
    isPff,
  );
  const segmentationStale =
    segmentRows.length !== expectedSegmentCount ||
    (isPff && segmentRows.some((r) => r.leg_phase == null));
  if (isPff && segmentationStale) {
    await ensurePffRouteSegmentsForOrder(order.id, ctx);
    const refreshed = await pool.query(
      `SELECT * FROM route_segment_costs WHERE route_id = $1 ORDER BY segment_index`,
      [routeId],
    );
    segmentRows = refreshed.rows;
    if (segmentRows.length !== expectedSegmentCount) {
      const summary = await calculateRouteCost(routeId, ctx);
      return ctx.role === "driver"
        ? scopeRouteSummaryForDriver(summary, ctx.userId)
        : summary;
    }
  }
  const needsRecalc = segmentRows.some((r) =>
    segmentNeedsRecalculation(String(r.cost_status) as SegmentCostStatus),
  );
  if (segmentRows.length === 0 || needsRecalc) {
    const summary = await calculateRouteCost(routeId, ctx);
    return ctx.role === "driver"
      ? scopeRouteSummaryForDriver(summary, ctx.userId)
      : summary;
  }

  const transporterIds = segmentRows.map((r) => Number(r.transporter_id));
  const names = await loadTransporterNames(transporterIds);

  const segments: RouteSegmentCostResponse[] = [];
  for (const row of segmentRows) {
    segments.push(
      await buildSegmentResponse(row, zoneMeta, names, zonePricing),
    );
  }

  const summary = await buildRouteSummaryResponse(route, order, segments);
  return ctx.role === "driver"
    ? scopeRouteSummaryForDriver(summary, ctx.userId)
    : summary;
}

export async function getRouteSegmentCosts(
  routeId: number,
  ctx: OrderContext,
): Promise<RouteSegmentCostResponse[]> {
  const summary = await getRouteCostSummary(routeId, ctx);
  return summary.segments;
}

export async function applyManualSegmentCost(
  segmentCostId: number,
  manualCost: number,
  ctx: OrderContext,
): Promise<RouteSegmentCostResponse> {
  return applyQuotedSegmentCost(segmentCostId, manualCost, "manual", ctx);
}

export async function applyExternalSegmentCost(
  segmentCostId: number,
  quotedCost: number,
  ctx: OrderContext,
): Promise<RouteSegmentCostResponse> {
  return applyQuotedSegmentCost(segmentCostId, quotedCost, "external", ctx);
}

export { isExternalQuoteConfigured };

export async function fetchExternalSegmentQuote(
  segmentCostId: number,
  ctx: OrderContext,
): Promise<RouteSegmentCostResponse> {
  if (!isExternalQuoteConfigured()) {
    throw new RouteCostError(
      "External quote webhook is not configured (EXTERNAL_QUOTE_WEBHOOK_URL)",
      503,
    );
  }

  const segResult = await pool.query(
    `SELECT sc.*, r.order_id, r.id AS route_id, r.zone_ids, o.sender_user_id, o.receiver_user_id
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     JOIN orders o ON o.id = r.order_id
     WHERE sc.id = $1`,
    [segmentCostId],
  );
  if (segResult.rowCount === 0)
    throw new RouteCostError("Segment cost not found", 404);
  const seg = segResult.rows[0];
  const senderId = Number(seg.sender_user_id);
  const receiverId = Number(seg.receiver_user_id);

  const isParty =
    ctx.role === "admin" ||
    (ctx.role === "sender" && ctx.userId === senderId) ||
    (ctx.role === "receiver" && ctx.userId === receiverId);
  if (!isParty) {
    throw new RouteCostError(
      "Only the order sender, receiver, or an admin can fetch external quotes",
      403,
    );
  }

  const status = String(seg.cost_status);
  const method = String(seg.transport_method);
  if (status === "manual") {
    throw new RouteCostError(
      "Segment already has a manual or external cost",
      400,
    );
  }
  if (status === "calculated" && method !== "air") {
    throw new RouteCostError(
      "External quotes apply to requested air/sea segments or missing costs",
      400,
    );
  }
  if (status !== "requested" && status !== "missing" && method !== "air") {
    throw new RouteCostError(
      "This segment does not need an external quote",
      400,
    );
  }

  const order = await getOrderById(Number(seg.order_id), ctx);
  if (!order) throw new RouteCostError("Order not found", 404);

  const zoneIds = parseJsonIntArray(seg.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIds);
  const zoneCoords = await loadZoneCentroids(zoneIds);
  const zoneNames = new Map<number, string>();
  for (const [id, meta] of zoneMeta) {
    zoneNames.set(id, meta.zone_name);
  }

  const from = nodeCoords(String(seg.from_node_id), order, zoneCoords);
  const to = nodeCoords(String(seg.to_node_id), order, zoneCoords);

  const payload: ExternalQuoteRequest = {
    transport_method: method,
    segment_index: Number(seg.segment_index),
    segment_cost_id: segmentCostId,
    order_id: order.id,
    from: {
      lat: from.lat,
      lng: from.lng,
      label: nodeLabel(String(seg.from_node_id), zoneNames),
    },
    to: {
      lat: to.lat,
      lng: to.lng,
      label: nodeLabel(String(seg.to_node_id), zoneNames),
    },
    weight_lbs: order.weight_lbs,
    package_type: order.package_type,
    package_factor: order.package_factor,
    dimensions_in: {
      length: order.package_length,
      width: order.package_width,
      height: order.package_height,
    },
    currency: String(seg.currency ?? "CAD"),
  };

  try {
    const quote = await fetchExternalQuote(payload);
    return applyQuotedSegmentCost(
      segmentCostId,
      quote.quoted_cost,
      "external",
      ctx,
    );
  } catch (err) {
    if (err instanceof ExternalQuoteError) {
      throw new RouteCostError(err.message, err.status);
    }
    throw err;
  }
}

export async function requestSegmentQuote(
  segmentCostId: number,
  ctx: OrderContext,
): Promise<RouteSegmentCostResponse> {
  const segResult = await pool.query(
    `SELECT sc.*, r.order_id, r.id AS route_id, r.transporter_ids, r.zone_ids, o.sender_user_id, o.receiver_user_id
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     JOIN orders o ON o.id = r.order_id
     WHERE sc.id = $1`,
    [segmentCostId],
  );
  if (segResult.rowCount === 0)
    throw new RouteCostError("Segment cost not found", 404);
  const seg = segResult.rows[0];
  const orderId = Number(seg.order_id);
  const senderId = Number(seg.sender_user_id);
  const receiverId = Number(seg.receiver_user_id);

  const isParty =
    ctx.role === "admin" ||
    (ctx.role === "sender" && ctx.userId === senderId) ||
    (ctx.role === "receiver" && ctx.userId === receiverId);
  if (!isParty) {
    throw new RouteCostError(
      "Only the order sender, receiver, or an admin can request a quote",
      403,
    );
  }

  const status = String(seg.cost_status);
  if (status === "manual") {
    throw new RouteCostError(
      "Manual costs cannot be reverted to a quote request",
      400,
    );
  }

  const pricedZoneId = pricedZoneIdForSegment(seg);
  if (pricedZoneId == null) {
    throw new RouteCostError(
      "Cannot resolve priced zone for this segment",
      400,
    );
  }

  const transporterId = Number(seg.transporter_id);
  const siblings = await findSiblingSegmentRows(
    orderId,
    transporterId,
    pricedZoneId,
    ["requested", "missing", "calculated", "manual"],
  );
  if (siblings.some((s) => String(s.cost_status) === "manual")) {
    throw new RouteCostError(
      "Manual costs cannot be reverted to a quote request",
      400,
    );
  }
  const pending = siblings.filter(
    (s) =>
      String(s.cost_status) === "missing" ||
      String(s.cost_status) === "calculated",
  );
  if (pending.length === 0) {
    throw new RouteCostError(
      "A quote has already been requested for this segment",
      400,
    );
  }

  const pendingIds = pending.map((s) => Number(s.id));
  await pool.query(
    `UPDATE route_segment_costs
     SET calculated_cost = NULL, manual_cost = NULL, final_cost = NULL,
         base_fee = NULL, distance_cost = NULL, waiting_cost = NULL, booking_fee = NULL,
         cost_status = 'requested', cost_source = NULL, calculation_breakdown = NULL,
         updated_at = NOW()
     WHERE id = ANY($1::int[])`,
    [pendingIds],
  );

  const routeIds = siblings.map((s) => Number(s.route_id));
  await recalculateRouteSummaries(routeIds);

  const zoneIds = parseJsonIntArray(seg.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIds);
  const zonePricing = await loadZonePricing(zoneIds);
  const names = await loadTransporterNames([transporterId]);
  const updated = await pool.query(
    `SELECT * FROM route_segment_costs WHERE id = $1`,
    [segmentCostId],
  );

  void createUserNotification({
    user_id: transporterId,
    order_id: orderId,
    type: "quote_request",
    title: "Quote requested",
    body: `A quote was requested for your segment on shipment #${orderId}. Open Quote Requests to respond.`,
  }).catch((err) =>
    console.error("[notifications] quote_request failed:", err),
  );

  return buildSegmentResponse(updated.rows[0], zoneMeta, names, zonePricing);
}

async function applyQuotedSegmentCost(
  segmentCostId: number,
  quotedCost: number,
  source: "manual" | "external",
  ctx: OrderContext,
): Promise<RouteSegmentCostResponse> {
  const segResult = await pool.query(
    `SELECT sc.*, r.order_id, r.id AS route_id, r.transporter_ids, r.zone_ids
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE sc.id = $1`,
    [segmentCostId],
  );
  if (segResult.rowCount === 0)
    throw new RouteCostError("Segment cost not found", 404);
  const seg = segResult.rows[0];

  if (ctx.role === "driver" && Number(seg.transporter_id) !== ctx.userId) {
    throw new RouteCostError(
      "You can only enter manual cost for your own segments",
      403,
    );
  }
  if (ctx.role !== "admin" && ctx.role !== "driver") {
    throw new RouteCostError(
      "Only admins and transporters can enter manual segment costs",
      403,
    );
  }

  const orderId = Number(seg.order_id);
  const transporterId = Number(seg.transporter_id);
  const pricedZoneId = pricedZoneIdForSegment(seg);
  if (pricedZoneId == null) {
    throw new RouteCostError(
      "Cannot resolve priced zone for this segment",
      400,
    );
  }

  const siblings = await findSiblingSegmentRows(
    orderId,
    transporterId,
    pricedZoneId,
    ["requested", "missing", "calculated", "manual"],
  );
  const siblingIds = siblings.map((s) => Number(s.id));
  const idsToUpdate = siblingIds.length > 0 ? siblingIds : [segmentCostId];
  if (idsToUpdate.length === 0) {
    throw new RouteCostError("Segment cost not found", 404);
  }

  await pool.query(
    `UPDATE route_segment_costs
     SET manual_cost = $2, final_cost = $2, cost_status = 'manual', cost_source = $3, updated_at = NOW()
     WHERE id = ANY($1::int[])`,
    [idsToUpdate, quotedCost, source],
  );

  await recalculateRouteSummaries(
    siblings.length > 0
      ? siblings.map((s) => Number(s.route_id))
      : [Number(seg.route_id)],
  );

  const zoneIdsQuoted = parseJsonIntArray(seg.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIdsQuoted);
  const zonePricing = await loadZonePricing(zoneIdsQuoted);
  const names = await loadTransporterNames([transporterId]);
  const updated = await pool.query(
    `SELECT * FROM route_segment_costs WHERE id = $1`,
    [segmentCostId],
  );
  return buildSegmentResponse(updated.rows[0], zoneMeta, names, zonePricing);
}

async function recalculateRouteSummary(routeId: number): Promise<void> {
  const segResult = await pool.query(
    `SELECT cost_status, final_cost, calculated_cost, manual_cost, currency
     FROM route_segment_costs WHERE route_id = $1`,
    [routeId],
  );
  const segments = segResult.rows.map((r) => ({
    cost_status: String(r.cost_status) as SegmentCostStatus,
    final_cost: r.final_cost != null ? Number(r.final_cost) : null,
  }));

  let totalCalculated = 0;
  let totalManual = 0;
  let calcCount = 0;
  let manualCount = 0;
  for (const row of segResult.rows) {
    if (row.cost_status === "calculated" && row.calculated_cost != null) {
      totalCalculated += Number(row.calculated_cost);
      calcCount++;
    }
    if (row.cost_status === "manual" && row.manual_cost != null) {
      totalManual += Number(row.manual_cost);
      manualCount++;
    }
  }

  const {
    status,
    missing_segment_count,
    requested_segment_count,
    total_final_cost,
  } = summarizeRouteStatus(segments);
  const routeResult = await pool.query(
    `SELECT order_id FROM order_routes WHERE id = $1`,
    [routeId],
  );
  const orderId = Number(routeResult.rows[0]?.order_id);

  await pool.query(
    `INSERT INTO route_cost_summaries
       (route_id, order_id, total_calculated_cost, total_manual_cost, total_final_cost,
        missing_segment_count, requested_segment_count, currency, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (route_id) DO UPDATE SET
       total_calculated_cost = EXCLUDED.total_calculated_cost,
       total_manual_cost = EXCLUDED.total_manual_cost,
       total_final_cost = EXCLUDED.total_final_cost,
       missing_segment_count = EXCLUDED.missing_segment_count,
       requested_segment_count = EXCLUDED.requested_segment_count,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [
      routeId,
      orderId,
      calcCount > 0 ? Math.round(totalCalculated * 100) / 100 : null,
      manualCount > 0 ? Math.round(totalManual * 100) / 100 : null,
      total_final_cost,
      missing_segment_count,
      requested_segment_count,
      String(segResult.rows[0]?.currency ?? "CAD"),
      status,
    ],
  );
}

async function resyncAndCostOrder(
  order: OrderResponse,
  ctx: OrderContext,
  liveChains?: RouteChain[],
): Promise<void> {
  const chains = liveChains ?? (await fetchLiveRouteChains(order));
  if (chains.length === 0) {
    await syncOrderRoutesFromPreview(order, []);
    return;
  }
  const preservedManual = await snapshotManualCosts(order.id);
  const routeIds = await syncOrderRoutesFromPreview(order, chains);
  for (const routeId of routeIds) {
    await calculateRouteCost(routeId, ctx, preservedManual);
  }
}

async function loadOrderRouteConnectivity(orderRow: OrderResponse): Promise<{
  isRouteComplete: boolean;
  scheduleInactiveZones: OrderRouteCostComparisonResponse["schedule_inactive_zones"];
  gapSummary: OrderRouteCostComparisonResponse["gap"];
}> {
  if (
    orderRow.sender_lat == null ||
    orderRow.sender_lng == null ||
    orderRow.destination_lat == null ||
    orderRow.destination_lng == null
  ) {
    return { isRouteComplete: true, scheduleInactiveZones: [], gapSummary: null };
  }
  try {
    const preview = await previewOrderZoneConnectionsByCoordinates({
      source_lat: orderRow.sender_lat,
      source_lng: orderRow.sender_lng,
      destination_lat: orderRow.destination_lat,
      destination_lng: orderRow.destination_lng,
      source_name: orderRow.source_name,
      source_address: orderRow.sender_address,
      destination_name: orderRow.receiver_name,
      destination_address: orderRow.destination_address,
      max_depth: DEFAULT_PREVIEW_MAX_DEPTH,
      schedule_at: orderRow.route_schedule_at ?? undefined,
    });
    return {
      isRouteComplete: preview.is_connected_to_destination,
      scheduleInactiveZones: preview.schedule_inactive_zones ?? [],
      gapSummary: preview.gap
        ? {
            distance_km: preview.gap.distance_km,
            bridge_message: preview.gap.bridge_message,
            bridge_candidates: preview.gap.bridge_candidates ?? [],
            message: preview.gap.message,
          }
        : null,
    };
  } catch {
    return { isRouteComplete: true, scheduleInactiveZones: [], gapSummary: null };
  }
}

function orderPackageFieldsForComparison(orderRow: OrderResponse) {
  const dims =
    orderRow.package_length != null &&
    orderRow.package_width != null &&
    orderRow.package_height != null
      ? `${orderRow.package_length} × ${orderRow.package_width} × ${orderRow.package_height} in`
      : orderRow.dimensions || null;
  const weightLbs =
    orderRow.weight_lbs != null ? Number(orderRow.weight_lbs) : null;
  return { dims, weightLbs };
}

async function buildOrderRouteComparison(
  orderId: number,
  ctx: OrderContext,
  liveChains?: RouteChain[],
  order?: OrderResponse,
): Promise<OrderRouteCostComparisonResponse> {
  const orderRow = order ?? (await getOrderForCostAccess(orderId, ctx));
  const lockInfo = await getOrderRouteLockInfo(orderId);
  const bookingFeeRate = await getBookingFeeRate();
  const pffFactor = await getPffFactor();
  const isPff = isPffPaymentMethod(orderRow.payment_method);
  const { dims, weightLbs } = orderPackageFieldsForComparison(orderRow);

  const connectivity = await loadOrderRouteConnectivity(orderRow);

  if (!lockInfo.locked && !connectivity.isRouteComplete) {
    const routesResult = await pool.query(
      `SELECT id FROM order_routes WHERE order_id = $1 LIMIT 1`,
      [orderId],
    );
    if ((routesResult.rowCount ?? 0) > 0) {
      await syncOrderRoutesFromPreview(orderRow, []);
    }

    return {
      order_id: orderId,
      currency: "CAD",
      booking_fee_rate: bookingFeeRate,
      pff_factor: pffFactor,
      is_pff_order: isPff,
      package_type: orderRow.package_type,
      packages: orderRow.packages,
      package_factor: orderRow.package_factor,
      package_weight_lbs: weightLbs,
      package_dimensions_in: dims,
      routes: [],
      route_locked: false,
      route_lock_reason: null,
      schedule_inactive_zones: connectivity.scheduleInactiveZones,
      route_schedule_at: orderRow.route_schedule_at ?? null,
      is_route_complete: false,
      gap: connectivity.gapSummary,
    };
  }

  const routesResult = await pool.query(
    `SELECT * FROM order_routes WHERE order_id = $1 ORDER BY route_index`,
    [orderId],
  );

  // For confirmed / in-progress deliveries, keep the persisted route snapshot
  // even when it no longer appears in the live zone graph.
  const liveSigs =
    !lockInfo.locked && liveChains
      ? new Set(liveChains.map(chainSignature))
      : null;
  const storedRows = liveSigs
    ? routesResult.rows.filter((r) => liveSigs.has(storedRouteSignature(r)))
    : routesResult.rows;

  const routes: RouteCostSummaryResponse[] = [];
  for (const route of storedRows) {
    const summary = await getRouteCostSummary(Number(route.id), ctx);
    if (ctx.role === "driver" && summary.segments.length === 0) continue;
    routes.push(summary);
  }

  routes.sort((a, b) => {
    if (a.total_final_cost == null && b.total_final_cost == null) return 0;
    if (a.total_final_cost == null) return 1;
    if (b.total_final_cost == null) return -1;
    return a.total_final_cost - b.total_final_cost;
  });

  const currency = routes[0]?.currency ?? "CAD";

  if (isPff) {
    routes.sort((a, b) => {
      if (a.total_final_cost == null && b.total_final_cost == null) return 0;
      if (a.total_final_cost == null) return 1;
      if (b.total_final_cost == null) return -1;
      return a.total_final_cost - b.total_final_cost;
    });
  }

  return {
    order_id: orderId,
    currency,
    booking_fee_rate: bookingFeeRate,
    pff_factor: pffFactor,
    is_pff_order: isPff,
    package_type: orderRow.package_type,
    packages: orderRow.packages,
    package_factor: orderRow.package_factor,
    package_weight_lbs: weightLbs,
    package_dimensions_in: dims,
    routes,
    route_locked: lockInfo.locked,
    route_lock_reason: lockInfo.reason,
    schedule_inactive_zones: connectivity.scheduleInactiveZones,
    route_schedule_at: orderRow.route_schedule_at ?? null,
    is_route_complete: connectivity.isRouteComplete,
    gap: connectivity.gapSummary,
  };
}

export async function recalculateRouteCostsForOrder(
  orderId: number,
  ctx: OrderContext,
  scheduleAt?: string | null
): Promise<OrderRouteCostComparisonResponse> {
  let order = await getOrderForCostAccess(orderId, ctx);
  if (order.tracking_status === "AWAITING_CONNECT") {
    throw new RouteCostError(
      "Sender must connect this shipment request before routes can be calculated",
      400,
    );
  }
  if (order.tracking_status === "REJECTED") {
    throw new RouteCostError("This shipment request was rejected", 400);
  }
  if (scheduleAt !== undefined) {
    order = await updateOrderRouteSchedule(orderId, scheduleAt, ctx);
  }
  const lockInfo = await getOrderRouteLockInfo(order.id);

  if (lockInfo.locked) {
    return buildOrderRouteComparison(orderId, ctx, undefined, order);
  }

  const liveChains = await withOrderResyncLock(order.id, async () => {
    const chains = await fetchLiveRouteChains(order);
    if (chains.length === 0) {
      await syncOrderRoutesFromPreview(order, []);
      return chains;
    }
    await resyncAndCostOrder(order, ctx, chains);
    return chains;
  });
  return buildOrderRouteComparison(orderId, ctx, liveChains, order);
}

export async function compareOrderRoutes(
  orderId: number,
  ctx: OrderContext,
): Promise<OrderRouteCostComparisonResponse> {
  const order = await getOrderForCostAccess(orderId, ctx);
  if (order.tracking_status === "AWAITING_CONNECT") {
    throw new RouteCostError(
      "Sender must connect this shipment request before routes can be calculated",
      400,
    );
  }

  const lockInfo = await getOrderRouteLockInfo(order.id);

  if (lockInfo.locked) {
    return buildOrderRouteComparison(orderId, ctx, undefined, order);
  }

  let liveChains = await fetchLiveRouteChains(order);

  if (liveChains.length === 0) {
    if (await orderRoutesNeedResync(order, liveChains)) {
      await withOrderResyncLock(order.id, async () => {
        if (await isOrderRouteLocked(order.id)) return;
        await syncOrderRoutesFromPreview(order, []);
      });
    }
    return buildOrderRouteComparison(orderId, ctx, liveChains, order);
  }

  if (isPffPaymentMethod(order.payment_method)) {
    await ensurePffRouteSegmentsForOrder(orderId, ctx);
  }

  if (await orderRoutesNeedResync(order, liveChains)) {
    liveChains = await withOrderResyncLock(order.id, async () => {
      if (await isOrderRouteLocked(order.id)) {
        return fetchLiveRouteChains(order);
      }
      const freshChains = await fetchLiveRouteChains(order);
      if (freshChains.length === 0) {
        await syncOrderRoutesFromPreview(order, []);
        return freshChains;
      }
      if (await orderRoutesNeedResync(order, freshChains)) {
        await resyncAndCostOrder(order, ctx, freshChains);
      }
      return freshChains;
    });
  }

  return buildOrderRouteComparison(orderId, ctx, liveChains, order);
}

export async function markMissingCostSegments(
  routeId: number,
  ctx: OrderContext,
): Promise<void> {
  await getRouteCostSummary(routeId, ctx);
}

export async function listTransporterQuoteRequests(
  ctx: OrderContext,
): Promise<TransporterQuoteRequestItem[]> {
  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new RouteCostError("Forbidden", 403);
  }

  const params: unknown[] = [];
  let transporterFilter = "";
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    transporterFilter = `AND sc.transporter_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT sc.*, r.id AS route_id, r.route_label, r.zone_ids, r.connection_ids, r.order_id,
            o.status AS order_status, o.sender_address, o.sender_lat, o.sender_lng,
            o.destination_address, o.destination_lat, o.destination_lng,
            o.package_type, o.weight_lbs, o.dimensions,
            o.package_length, o.package_width, o.package_height
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     JOIN orders o ON o.id = r.order_id
     WHERE sc.cost_status IN ('requested', 'missing')
     ${transporterFilter}
     ORDER BY
       CASE WHEN sc.cost_status = 'requested' THEN 0 ELSE 1 END,
       sc.updated_at DESC`,
    params,
  );

  const items: TransporterQuoteRequestItem[] = [];
  type RowGroup = {
    rows: Array<
      Record<string, unknown> & { route_id: number; route_label: string }
    >;
    pricedZoneId: number;
  };
  const groups = new Map<string, RowGroup>();

  for (const row of result.rows) {
    const pricedZoneId = pricedZoneIdForSegment(row);
    if (pricedZoneId == null) continue;
    const key = quoteDedupKey(
      Number(row.order_id),
      Number(row.transporter_id),
      pricedZoneId,
    );
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { rows: [row], pricedZoneId });
    }
  }

  for (const group of groups.values()) {
    const rows = group.rows.sort((a, b) => {
      const statusRank = (s: unknown) => (String(s) === "requested" ? 0 : 1);
      const rankDiff = statusRank(a.cost_status) - statusRank(b.cost_status);
      if (rankDiff !== 0) return rankDiff;
      return (
        new Date(String(b.updated_at)).getTime() -
        new Date(String(a.updated_at)).getTime()
      );
    });
    const primary = rows[0];
    const zoneIds = parseJsonIntArray(primary.zone_ids);
    const zoneMeta = await loadZoneMetaForIds(zoneIds);
    const zonePricing = await loadZonePricing(zoneIds);
    const names = await loadTransporterNames([Number(primary.transporter_id)]);
    const segment = await buildSegmentResponse(
      primary,
      zoneMeta,
      names,
      zonePricing,
    );

    const affectedRoutes: AffectedRouteRef[] = [];
    const routeSeen = new Set<number>();
    for (const row of rows) {
      const rid = Number(row.route_id);
      if (routeSeen.has(rid)) continue;
      routeSeen.add(rid);
      affectedRoutes.push({
        route_id: rid,
        route_label: String(row.route_label),
      });
    }
    affectedRoutes.sort((a, b) => a.route_label.localeCompare(b.route_label));

    const dims =
      primary.package_length != null &&
      primary.package_width != null &&
      primary.package_height != null
        ? `${primary.package_length} × ${primary.package_width} × ${primary.package_height} in`
        : primary.dimensions != null
          ? String(primary.dimensions)
          : null;

    items.push({
      order_id: Number(primary.order_id),
      order_status: String(primary.order_status),
      sender_address: String(primary.sender_address ?? ""),
      sender_lat:
        primary.sender_lat != null ? Number(primary.sender_lat) : null,
      sender_lng:
        primary.sender_lng != null ? Number(primary.sender_lng) : null,
      destination_address: String(primary.destination_address ?? ""),
      destination_lat:
        primary.destination_lat != null
          ? Number(primary.destination_lat)
          : null,
      destination_lng:
        primary.destination_lng != null
          ? Number(primary.destination_lng)
          : null,
      package_type:
        primary.package_type != null ? String(primary.package_type) : null,
      package_weight_lbs:
        primary.weight_lbs != null ? Number(primary.weight_lbs) : null,
      package_dimensions_in: dims,
      priced_zone_id: group.pricedZoneId,
      route_id: Number(primary.route_id),
      route_label: String(primary.route_label),
      zone_ids: zoneIds,
      connection_ids: parseJsonIntArray(primary.connection_ids),
      affected_routes: affectedRoutes,
      segment_ids: rows.map((r) => Number(r.id)),
      segment,
      updated_at: new Date(String(primary.updated_at)).toISOString(),
    });
  }

  items.sort((a, b) => {
    const statusRank = (s: SegmentCostStatus) => (s === "requested" ? 0 : 1);
    const rankDiff =
      statusRank(a.segment.cost_status) - statusRank(b.segment.cost_status);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return items;
}
