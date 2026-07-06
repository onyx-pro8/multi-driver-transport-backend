import { cellToLatLng, isValidCell, latLngToCell } from "h3-js";
import { pool } from "../database";
import type {
  AdjacentCellPair,
  ConnectionType,
  HubRole,
} from "../models/zoneConnection.model";
import {
  buildZoneScheduleFields,
  describeZoneScheduleInactiveReason,
  formatZoneScheduleSummary,
  isZoneScheduleActive,
  parseScheduleFromRow,
} from "./zoneSchedule.service";
import { getOrderById, OrderError, type OrderContext } from "./order.service";

/**
 * Milestone 2 — Order draft preview.
 *
 * Given the sender's pickup coordinates and the receiver's drop-off
 * coordinates (both pre-submit, no order row yet), project the persisted
 * `zone_connections` graph down to the slice that is relevant to this
 * order: pickup-covering zones, destination-covering zones, and any chain
 * of overlap/adjacency that links the two sides.
 *
 * Strictly a preview — no driver assignment, no route generation. The UI
 * labels everything as "preview / not a final route".
 */

/** Default H3 resolution for the *display* pickup / drop-off cells. */
export const ORDER_H3_RESOLUTION = 8;

/** Default BFS depth limit when walking the zone-connection graph. */
export const DEFAULT_PREVIEW_MAX_DEPTH = 15;

/**
 * Great-circle distance between two lat/lng points, in kilometres.
 * Used only to scale the *display* H3 resolution of the preview cells —
 * not for any persisted value.
 */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371; // mean Earth radius (km)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Pick an H3 resolution for the preview's pickup / drop-off cells based on
 * how far apart they are. The preview map auto-fits both points, so a fixed
 * res-8 hexagon becomes a barely-visible dot when the two ends are far
 * apart. Scaling the resolution keeps the cell a readable fraction of the
 * fitted view (roughly 10–20% of the pickup→drop-off span).
 *
 * Approx H3 hexagon edge lengths: r4 ~22.6 km, r5 ~8.5, r6 ~3.2, r7 ~1.2,
 * r8 ~0.46, r9 ~0.17, r10 ~0.066. This is display-only — the stored
 * `pickup_h3` / `delivery_h3` on the order always use `ORDER_H3_RESOLUTION`.
 */
export function pickPreviewResolution(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return ORDER_H3_RESOLUTION;
  if (distanceKm >= 150) return 4;
  if (distanceKm >= 60) return 5;
  if (distanceKm >= 20) return 6;
  if (distanceKm >= 7) return 7;
  if (distanceKm >= 2.5) return 8;
  if (distanceKm >= 0.8) return 9;
  return 10;
}

export type OrderConnectionStatus =
  | "connected"
  | "not_connected"
  | "no_pickup_zone"
  | "no_destination_zone";

export interface OrderDraftPreviewInput {
  source_lat: number;
  source_lng: number;
  destination_lat: number;
  destination_lng: number;
  source_name?: string;
  source_address?: string;
  destination_name?: string;
  destination_address?: string;
  /** BFS depth limit. Clamped to 1..20. */
  max_depth?: number;
  /**
   * How many hops beyond the shortest route an alternative path may take and
   * still be shown ("slightly winding" allowance). Defaults to
   * `DEFAULT_EXTRA_HOPS`. Clamped to 0..6.
   */
  extra_hops?: number;
  /** ISO datetime for schedule-aware route preview (defaults to now). */
  schedule_at?: string;
}

export interface OrderDraftZoneSummary {
  zone_id: number;
  zone_name: string;
  transport_id: number;
  transport_name: string;
  transport_method: string | null;
  cell_count: number;
  resolution: number;
  /**
   * H3 cells for the zone, sampled down to `MAX_CELLS_PER_PREVIEW_ZONE` for
   * map rendering. The full set stays in the database — we only ship a
   * representative slice so the map can outline the zone without DOM-melting
   * geofence-derived zones with tens of thousands of cells.
   */
  cells: string[];
  is_pickup: boolean;
  is_destination: boolean;
  /** BFS depth from the nearest pickup zone (0 = pickup). null if unreached. */
  depth: number | null;
  /** Air/sea route terminals (null for land zones) so the map can draw the leg. */
  departure_hub: OrderDraftHub | null;
  arrival_hub: OrderDraftHub | null;
  departure_time: string | null;
  arrival_time: string | null;
  operation_date: string | null;
  operation_start_date: string | null;
  operation_end_date: string | null;
  schedule_pattern: string;
  weekday_start: number | null;
  weekday_end: number | null;
  month_day_start: number | null;
  month_day_end: number | null;
  operating_start_time: string | null;
  operating_end_time: string | null;
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  currency: string;
  trust_payment_forwarder: boolean;
  driver_trustworthiness: number;
}

export interface OrderDraftHub {
  name: string;
  lat: number;
  lng: number;
}

export interface OrderDraftConnection {
  id: number;
  from_zone_id: number;
  to_zone_id: number;
  connection_type: ConnectionType;
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[];
  used_in_preview: boolean;
  /** For `hub` connections: which terminal of the air/sea side is the handoff. */
  hub_role_a: HubRole | null;
  hub_role_b: HubRole | null;
}

export interface OrderDraftChain {
  zone_ids: number[];
  connection_ids: number[];
  hops: number;
}

/**
 * Milestone 4 — what we surface when no *complete* pickup→destination route
 * exists. `pickup_chain` is how far the order can travel from the pickup side
 * (the incomplete route), `destination_chain` is the slice that can reach the
 * destination, and the two frontier zones plus `distance_km` describe the gap
 * a new/extended transport zone would need to close.
 */
export interface OrderDraftGap {
  /** Last zone reachable from the pickup side (frontier of the incomplete route). */
  pickup_frontier_zone_id: number | null;
  /** Closest zone on the destination side to that pickup frontier. */
  destination_frontier_zone_id: number | null;
  /** Straight-line distance between the two frontier zones (km), rounded. */
  distance_km: number | null;
  /** Incomplete route pickup → … → pickup frontier. */
  pickup_chain: OrderDraftChain | null;
  /** Incomplete route destination frontier → … → drop-off. */
  destination_chain: OrderDraftChain | null;
  /** Name of the transporter whose zone is nearest the gap (suggested handoff). */
  suggested_transport_name: string | null;
  /** Name of the zone nearest the gap. */
  suggested_zone_name: string | null;
  /** Human-readable explanation + suggestion for the sender. */
  message: string;
  /** Zones in the network that could bridge this gap (may be closed by schedule). */
  bridge_candidates: GapBridgeCandidate[];
  /** Short summary of bridge zone availability. */
  bridge_message: string | null;
}

export interface GapBridgeCandidate {
  zone_id: number;
  zone_name: string;
  transport_name: string;
  schedule_active: boolean;
  schedule_summary: string | null;
  inactive_reason: string | null;
  on_pickup_side: boolean;
  on_destination_side: boolean;
}

export interface OrderDraftPreview {
  source: {
    name: string;
    address: string;
    lat: number;
    lng: number;
    h3: string;
  };
  destination: {
    name: string;
    address: string;
    lat: number;
    lng: number;
    h3: string;
  };
  preview_resolution: number;
  max_depth: number;
  pickup_zones: OrderDraftZoneSummary[];
  destination_zones: OrderDraftZoneSummary[];
  connected_zones: OrderDraftZoneSummary[];
  connections: OrderDraftConnection[];
  transfer_cells: string[];
  is_connected_to_destination: boolean;
  status: OrderConnectionStatus;
  message: string;
  possible_connection_chains: OrderDraftChain[];
  /**
   * Milestone 4 — populated only when there is no complete route but both
   * sides have at least one covering zone. Carries the incomplete routes and
   * the nearest gap suggestion. `null` when a full route exists or a side has
   * no covering zone at all.
   */
  gap: OrderDraftGap | null;
  /** Zones covering pickup/destination that exist but are outside their operating window. */
  schedule_inactive_zones: ScheduleInactiveZone[];
}

export interface ScheduleInactiveZone {
  zone_id: number;
  zone_name: string;
  transport_name: string;
  schedule_summary: string | null;
  /** Why the zone is excluded from routing at the preview time. */
  inactive_reason: string | null;
  covers: "pickup" | "destination" | "both";
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

/**
 * Lightweight zone metadata. Crucially we do NOT pull `h3_cells` into Node:
 * geofence zones can have tens of thousands of cells and pulling them all
 * via `SELECT z.h3_cells` makes the preview endpoint feel "stuck" even when
 * it's only doing a handful of zones. Membership is pushed down to SQL
 * (see `findCoveringZoneIdsSql`) which leans on the GIN index that already
 * exists on `driver_zones.h3_cells`.
 */
interface ZoneMeta {
  id: number;
  zone_name: string;
  owner_user_id: number;
  transport_name: string;
  transport_mode: string | null;
  resolution: number;
  cell_count: number;
  departure_hub: OrderDraftHub | null;
  arrival_hub: OrderDraftHub | null;
  departure_time: string | null;
  arrival_time: string | null;
  operation_date: string | null;
  operation_start_date: string | null;
  operation_end_date: string | null;
  schedule_pattern: string;
  weekday_start: number | null;
  weekday_end: number | null;
  month_day_start: number | null;
  month_day_end: number | null;
  operating_start_time: string | null;
  operating_end_time: string | null;
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  currency: string;
  trust_payment_forwarder: boolean;
  driver_trustworthiness: number;
}

interface ConnectionRow {
  id: number;
  zone_a_id: number;
  zone_b_id: number;
  connection_type: ConnectionType;
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[];
  hub_role_a: HubRole | null;
  hub_role_b: HubRole | null;
}

function parseOrderHub(
  row: Record<string, unknown>,
  prefix: "departure_hub" | "arrival_hub"
): OrderDraftHub | null {
  const name = row[`${prefix}_name`];
  const lat = Number(row[`${prefix}_lat`]);
  const lng = Number(row[`${prefix}_lng`]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { name: name == null ? "" : String(name), lat, lng };
}

function parseCellsJsonb(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((c) => c.toLowerCase());
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map(String).map((c) => c.toLowerCase())
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parsePairsJsonb(raw: unknown): AdjacentCellPair[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is { from_cell: unknown; to_cell: unknown } =>
        Boolean(p && typeof p === "object" && "from_cell" in p && "to_cell" in p)
      )
      .map((p) => ({ from_cell: String(p.from_cell), to_cell: String(p.to_cell) }));
  }
  if (typeof raw === "string") {
    try {
      return parsePairsJsonb(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function mapRowToZoneMeta(row: Record<string, unknown>): ZoneMeta {
  const schedule = parseScheduleFromRow(row);
  return {
    id: Number(row.id),
    zone_name: String(row.zone_name ?? ""),
    owner_user_id: Number(row.owner_user_id),
    transport_name: String(row.transport_name ?? ""),
    transport_mode: row.transport_mode == null ? null : String(row.transport_mode),
    resolution: Number(row.resolution ?? 0),
    cell_count: Number(row.cell_count ?? 0),
    departure_hub: parseOrderHub(row, "departure_hub"),
    arrival_hub: parseOrderHub(row, "arrival_hub"),
    departure_time: schedule.departure_time,
    arrival_time: schedule.arrival_time,
    operation_date: schedule.operation_date,
    operation_start_date: schedule.operation_start_date,
    operation_end_date: schedule.operation_end_date,
    schedule_pattern: schedule.schedule_pattern,
    weekday_start: schedule.weekday_start,
    weekday_end: schedule.weekday_end,
    month_day_start: schedule.month_day_start,
    month_day_end: schedule.month_day_end,
    operating_start_time: schedule.operating_start_time,
    operating_end_time: schedule.operating_end_time,
    base_fee: row.base_fee == null ? null : Number(row.base_fee),
    cost_per_km: row.cost_per_km == null ? null : Number(row.cost_per_km),
    cost_per_hour: row.cost_per_hour == null ? null : Number(row.cost_per_hour),
    currency: row.currency == null ? "USD" : String(row.currency),
    trust_payment_forwarder: Boolean(row.trust_payment_forwarder),
    driver_trustworthiness: Number(row.driver_trustworthiness ?? 0),
  };
}

function zoneMetaScheduleFields(z: ZoneMeta) {
  return buildZoneScheduleFields({
    transport_mode: z.transport_mode ?? "land",
    operation_date: z.operation_date,
    operation_start_date: z.operation_start_date,
    operation_end_date: z.operation_end_date,
    schedule_pattern: z.schedule_pattern,
    weekday_start: z.weekday_start,
    weekday_end: z.weekday_end,
    month_day_start: z.month_day_start,
    month_day_end: z.month_day_end,
    operating_start_time: z.operating_start_time,
    operating_end_time: z.operating_end_time,
    departure_time: z.departure_time,
    arrival_time: z.arrival_time,
  });
}

function resolveScheduleAt(iso: string | null | undefined): Date {
  if (iso?.trim()) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

async function loadAllAvailableZoneMeta(): Promise<ZoneMeta[]> {
  // Note: `h3_cells` is intentionally NOT selected here — see ZoneMeta doc.
  const result = await pool.query(
    `SELECT z.id,
            z.zone_name,
            z.owner_user_id,
            z.transport_mode,
            z.resolution,
            jsonb_array_length(z.h3_cells) AS cell_count,
            z.departure_hub_name, z.departure_hub_lat, z.departure_hub_lng,
            z.arrival_hub_name, z.arrival_hub_lat, z.arrival_hub_lng,
            z.departure_time, z.arrival_time,
            z.operation_date, z.operation_start_date, z.operation_end_date,
            z.schedule_pattern, z.weekday_start, z.weekday_end,
            z.month_day_start, z.month_day_end,
            z.operating_start_time, z.operating_end_time,
            z.base_fee, z.cost_per_km, z.cost_per_hour, z.currency,
            z.trust_payment_forwarder,
            COALESCE(u.trustworthiness, 0) AS driver_trustworthiness,
            u.full_name AS transport_name
     FROM driver_zones z
     JOIN users u ON u.id = z.owner_user_id
     WHERE z.available = TRUE`
  );
  return result.rows.map((row) => mapRowToZoneMeta(row));
}

async function loadZoneMeta(): Promise<ZoneMeta[]> {
  const now = new Date();
  const all = await loadAllAvailableZoneMeta();
  return all.filter((z) => isZoneScheduleActive(zoneMetaScheduleFields(z), now));
}

function buildScheduleInactiveZones(
  pickupIdsRaw: Set<number>,
  destIdsRaw: Set<number>,
  activeZoneIds: Set<number>,
  allZonesById: Map<number, ZoneMeta>,
  now: Date,
): ScheduleInactiveZone[] {
  const items: ScheduleInactiveZone[] = [];
  const seen = new Set<number>();

  function add(id: number, covers: ScheduleInactiveZone["covers"]) {
    if (activeZoneIds.has(id) || seen.has(id)) return;
    const z = allZonesById.get(id);
    if (!z) return;
    seen.add(id);
    const fields = zoneMetaScheduleFields(z);
    const inactive = describeZoneScheduleInactiveReason(fields, now);
    items.push({
      zone_id: z.id,
      zone_name: z.zone_name,
      transport_name: z.transport_name,
      schedule_summary: formatZoneScheduleSummary(fields),
      inactive_reason: inactive?.label ?? "Not available at this time",
      covers,
    });
  }

  for (const id of pickupIdsRaw) {
    add(id, destIdsRaw.has(id) ? "both" : "pickup");
  }
  for (const id of destIdsRaw) {
    add(id, pickupIdsRaw.has(id) ? "both" : "destination");
  }

  return items.sort((a, b) => a.transport_name.localeCompare(b.transport_name));
}

/**
 * Find which available zones cover (lat, lng) by pushing membership into SQL.
 *
 * H3 cells encode their resolution, so a candidate cell computed at res N can
 * only ever match a zone whose `h3_cells` JSONB array stores res-N cells.
 * That means we can hand SQL the set of candidates {res 0..15} and rely on
 * `?|` (jsonb-has-any-of-keys) + the existing GIN index to return only the
 * zones that actually contain the point — no JSON arrays travel to Node.
 */
async function findCoveringZoneIdsSql(lat: number, lng: number): Promise<Set<number>> {
  const candidates: string[] = [];
  for (let r = 0; r <= 15; r++) {
    try {
      candidates.push(latLngToCell(lat, lng, r).toLowerCase());
    } catch {
      // skip res that h3-js rejects for this point (shouldn't happen)
    }
  }
  if (candidates.length === 0) return new Set();
  const result = await pool.query(
    `SELECT z.id
     FROM driver_zones z
     WHERE z.available = TRUE
       AND z.h3_cells ?| $1::text[]`,
    [candidates]
  );
  return new Set(result.rows.map((r) => Number(r.id)));
}

async function loadConnections(): Promise<ConnectionRow[]> {
  const result = await pool.query(
    `SELECT id, zone_a_id, zone_b_id, connection_type,
            transfer_cells, adjacent_cell_pairs, hub_role_a, hub_role_b
     FROM zone_connections
     WHERE is_active = TRUE`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    zone_a_id: Number(row.zone_a_id),
    zone_b_id: Number(row.zone_b_id),
    connection_type: row.connection_type as ConnectionType,
    transfer_cells: parseCellsJsonb(row.transfer_cells),
    adjacent_cell_pairs: parsePairsJsonb(row.adjacent_cell_pairs),
    hub_role_a: (row.hub_role_a == null ? null : String(row.hub_role_a)) as HubRole | null,
    hub_role_b: (row.hub_role_b == null ? null : String(row.hub_role_b)) as HubRole | null,
  }));
}

function pickZones(ids: Set<number>, byId: Map<number, ZoneMeta>): ZoneMeta[] {
  const out: ZoneMeta[] = [];
  ids.forEach((id) => {
    const z = byId.get(id);
    if (z) out.push(z);
  });
  return out;
}

/**
 * Cap on cells we ship per preview-relevant zone.
 *
 * The user wants to see the *full* origin zones on the preview map (e.g.
 * "Driver A and Driver B's zones with the overlapped part highlighted"),
 * not a thinned-out sample, so we set this to a deliberately generous
 * value. Most driver-drawn zones have tens to hundreds of cells; even
 * mid-sized geofence zones at res 8/9 fit comfortably under 5000.
 *
 * Pathologically large geofence zones (>5000 cells) still get sampled —
 * Leaflet would otherwise render tens of thousands of <Polygon> elements
 * and freeze the browser. For those edge cases a future enhancement can
 * fall back to drawing just the zone's stored polygon `boundary`.
 */
const MAX_CELLS_PER_PREVIEW_ZONE = 5000;

function sampleEvenly(arr: readonly string[], max: number): string[] {
  if (arr.length <= max) return [...arr];
  const out: string[] = [];
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

/**
 * Load `h3_cells` ONLY for the zones we are about to surface in the
 * preview (pickup-covering, destination-covering, BFS-reached). For the
 * common 2..10 relevant zones this is a single targeted query — much
 * cheaper than pulling cells for every available zone.
 */
async function loadCellsForZoneIds(ids: number[]): Promise<Map<number, string[]>> {
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, h3_cells FROM driver_zones WHERE id = ANY($1::int[])`,
    [ids]
  );
  const out = new Map<number, string[]>();
  for (const row of result.rows) {
    const cells = parseCellsJsonb(row.h3_cells);
    out.set(Number(row.id), sampleEvenly(cells, MAX_CELLS_PER_PREVIEW_ZONE));
  }
  return out;
}

interface BfsState {
  depth: Map<number, number>;
  parent: Map<number, number>;
  parentEdge: Map<number, number>;
  usedConnectionIds: Set<number>;
}

function bfsFromPickup(
  pickupZoneIds: number[],
  adjacency: Map<number, { neighbour: number; connection: ConnectionRow }[]>,
  maxDepth: number
): BfsState {
  const depth = new Map<number, number>();
  const parent = new Map<number, number>();
  const parentEdge = new Map<number, number>();
  const usedConnectionIds = new Set<number>();

  const queue: number[] = [];
  for (const id of pickupZoneIds) {
    if (!depth.has(id)) {
      depth.set(id, 0);
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current) ?? 0;
    if (currentDepth >= maxDepth) continue;
    const edges = adjacency.get(current) ?? [];
    for (const { neighbour, connection } of edges) {
      if (depth.has(neighbour)) continue;
      depth.set(neighbour, currentDepth + 1);
      parent.set(neighbour, current);
      parentEdge.set(neighbour, connection.id);
      usedConnectionIds.add(connection.id);
      queue.push(neighbour);
    }
  }
  return { depth, parent, parentEdge, usedConnectionIds };
}

/**
 * Multi-source BFS that returns, for every reachable zone, the minimum
 * number of hops to the *nearest* zone in `sources`. Used as an admissible
 * lower bound when enumerating paths so we can prune branches that could
 * never reach a destination within the hop budget.
 */
function minHopsToAny(
  sources: number[],
  adjacency: Map<number, { neighbour: number; connection: ConnectionRow }[]>,
  maxDepth: number
): Map<number, number> {
  const dist = new Map<number, number>();
  const queue: number[] = [];
  for (const s of sources) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const d = dist.get(current)!;
    if (d >= maxDepth) continue;
    for (const { neighbour } of adjacency.get(current) ?? []) {
      if (!dist.has(neighbour)) {
        dist.set(neighbour, d + 1);
        queue.push(neighbour);
      }
    }
  }
  return dist;
}

/**
 * Extra hops beyond the shortest pickup→destination distance that a path is
 * still allowed to take. Keeps "slightly winding" alternatives while
 * discarding routes that would feel absurdly roundabout.
 */
const DEFAULT_EXTRA_HOPS = 2;

/** Safety caps so a dense graph can't blow up the enumeration. */
const MAX_PREVIEW_CHAINS = 25;
const MAX_ENUMERATION_STEPS = 200_000;

interface EnumeratedChains {
  chains: OrderDraftChain[];
  usedConnectionIds: Set<number>;
  zoneIds: Set<number>;
}

/**
 * Which terminal (departure/arrival) of an air/sea zone a connection attaches
 * to. Hub connections only ever carry a role on the air/sea side, so this is
 * non-null exactly when `zoneId` is the hub zone of `conn`. Returns null for
 * land zones and land↔land connections.
 */
function hubTerminalOf(conn: ConnectionRow, zoneId: number): HubRole | null {
  if (conn.zone_a_id === zoneId) return conn.hub_role_a;
  if (conn.zone_b_id === zoneId) return conn.hub_role_b;
  return null;
}

/**
 * Enumerate *all* simple pickup→destination paths whose length stays within
 * `shortest + extraHops` hops. Unlike the old BFS-tree reconstruction (one
 * path per destination), this surfaces every reasonable alternative the
 * sender could be routed through.
 *
 * Pruning: a partial path at `current` with `hopsSoFar` hops is abandoned as
 * soon as `hopsSoFar + minHopsToDest(current) > hopBudget`, so we never walk
 * down branches that can't finish on budget. Simple-path (no zone revisited)
 * keeps it finite; the step/chain caps bound the worst case.
 */
function enumerateChains(
  pickupZoneIds: number[],
  destSet: Set<number>,
  adjacency: Map<number, { neighbour: number; connection: ConnectionRow }[]>,
  maxDepth: number,
  extraHops: number
): EnumeratedChains {
  const chains: OrderDraftChain[] = [];
  const usedConnectionIds = new Set<number>();
  const zoneIds = new Set<number>();

  const distToDest = minHopsToAny(Array.from(destSet), adjacency, maxDepth);

  let shortest = Infinity;
  for (const p of pickupZoneIds) {
    const d = distToDest.get(p);
    if (d != null && d < shortest) shortest = d;
  }
  if (!Number.isFinite(shortest)) return { chains, usedConnectionIds, zoneIds };

  const hopBudget = Math.min(maxDepth, shortest + Math.max(0, extraHops));

  const visited = new Set<number>();
  const zonePath: number[] = [];
  const edgePath: number[] = [];
  let steps = 0;

  function record() {
    chains.push({
      zone_ids: [...zonePath],
      connection_ids: [...edgePath],
      hops: edgePath.length,
    });
    for (const e of edgePath) usedConnectionIds.add(e);
    for (const z of zonePath) zoneIds.add(z);
  }

  // `entryConn` is the connection the path used to arrive at `current` (undefined
  // for the pickup zone where the path starts).
  function dfs(current: number, entryConn: ConnectionRow | undefined): void {
    if (chains.length >= MAX_PREVIEW_CHAINS || steps >= MAX_ENUMERATION_STEPS) return;
    steps++;

    // Destinations are terminal — stop extending so we don't manufacture
    // routes that pass *through* one destination on the way to another.
    if (destSet.has(current)) {
      record();
      return;
    }

    // If we arrived at an air/sea zone via one of its terminals, the only way
    // out that actually *uses* the flight/voyage is via the OTHER terminal.
    // Leaving through the same terminal means the leg between departure and
    // arrival is never travelled, so the air/sea zone is pointless on this
    // route — skip those exits entirely.
    const entryTerminal = entryConn ? hubTerminalOf(entryConn, current) : null;

    for (const { neighbour, connection } of adjacency.get(current) ?? []) {
      if (visited.has(neighbour)) continue;
      if (entryTerminal != null) {
        const exitTerminal = hubTerminalOf(connection, current);
        if (exitTerminal != null && exitTerminal === entryTerminal) continue;
      }
      const remaining = distToDest.get(neighbour);
      if (remaining == null) continue; // neighbour can't reach any destination
      if (edgePath.length + 1 + remaining > hopBudget) continue; // too roundabout

      visited.add(neighbour);
      zonePath.push(neighbour);
      edgePath.push(connection.id);
      dfs(neighbour, connection);
      edgePath.pop();
      zonePath.pop();
      visited.delete(neighbour);

      if (chains.length >= MAX_PREVIEW_CHAINS || steps >= MAX_ENUMERATION_STEPS) return;
    }
  }

  for (const p of pickupZoneIds) {
    if (distToDest.get(p) == null) continue;
    visited.add(p);
    zonePath.push(p);
    dfs(p, undefined);
    zonePath.pop();
    visited.delete(p);
    if (chains.length >= MAX_PREVIEW_CHAINS) break;
  }

  // Shortest first, then fewer zones, so the UI lists the cleanest routes up top.
  chains.sort((a, b) => a.hops - b.hops || a.zone_ids.length - b.zone_ids.length);
  return { chains, usedConnectionIds, zoneIds };
}

// NOTE: `bfsFromPickup` is still used to compute each zone's depth (distance
// from the nearest pickup) for ordering/labelling. The single-path
// `reconstructChains` helper it used to feed has been replaced by
// `enumerateChains`, which surfaces every reasonable route.

// --------------------------------------------------------------------------
// Milestone 4 — incomplete routes & nearest-gap suggestion
// --------------------------------------------------------------------------

/** Hard cap on how many zones we consider when searching for the nearest gap. */
const MAX_GAP_CANDIDATES = 150;

/** Cheap centroid from a sample of a zone's H3 cells. */
function centroidOfCells(cells: readonly string[]): { lat: number; lng: number } | null {
  let latSum = 0;
  let lngSum = 0;
  let count = 0;
  for (const cell of cells) {
    if (!isValidCell(cell)) continue;
    try {
      const [lat, lng] = cellToLatLng(cell);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        latSum += lat;
        lngSum += lng;
        count++;
      }
    } catch {
      /* skip */
    }
  }
  if (count === 0) return null;
  return { lat: latSum / count, lng: lngSum / count };
}

/**
 * Load an approximate centroid for each zone id. Only a small slice of each
 * zone's `h3_cells` is pulled (LIMIT in SQL) so this stays cheap even for
 * geofence zones with tens of thousands of cells — we only need a rough
 * centre to measure the gap between two zones.
 */
async function loadZoneCentroids(
  ids: number[]
): Promise<Map<number, { lat: number; lng: number }>> {
  const out = new Map<number, { lat: number; lng: number }>();
  if (ids.length === 0) return out;
  const result = await pool.query(
    `SELECT z.id,
            COALESCE(
              (SELECT jsonb_agg(elem)
               FROM jsonb_array_elements_text(z.h3_cells)
                 WITH ORDINALITY AS t(elem, ord)
               WHERE ord <= 80),
              '[]'::jsonb
            ) AS sample
     FROM driver_zones z
     WHERE z.id = ANY($1::int[])`,
    [ids]
  );
  for (const row of result.rows) {
    const centroid = centroidOfCells(parseCellsJsonb(row.sample));
    if (centroid) out.set(Number(row.id), centroid);
  }
  return out;
}

/**
 * Reconstruct the chain `source → … → target` from a BFS parent tree.
 * Returns `null` if the target was never reached from any source.
 */
function reconstructChain(target: number, bfs: BfsState): OrderDraftChain | null {
  if (!bfs.depth.has(target)) return null;
  const zones: number[] = [];
  const edges: number[] = [];
  const guard = new Set<number>();
  let cur: number | undefined = target;
  while (cur != null && !guard.has(cur)) {
    guard.add(cur);
    zones.push(cur);
    if (!bfs.parent.has(cur)) break;
    const edge = bfs.parentEdge.get(cur);
    if (edge != null) edges.push(edge);
    cur = bfs.parent.get(cur);
  }
  zones.reverse();
  edges.reverse();
  return { zone_ids: zones, connection_ids: edges, hops: edges.length };
}

function reverseChain(chain: OrderDraftChain): OrderDraftChain {
  return {
    zone_ids: [...chain.zone_ids].reverse(),
    connection_ids: [...chain.connection_ids].reverse(),
    hops: chain.hops,
  };
}

/** Closest centroid pair across the pickup-side and destination-side zones. */
function nearestZonePair(
  pickupSide: number[],
  destSide: number[],
  centroids: Map<number, { lat: number; lng: number }>
): { from: number; to: number; km: number } | null {
  let best: { from: number; to: number; km: number } | null = null;
  for (const p of pickupSide) {
    const cp = centroids.get(p);
    if (!cp) continue;
    for (const d of destSide) {
      const cd = centroids.get(d);
      if (!cd) continue;
      const km = haversineKm(cp.lat, cp.lng, cd.lat, cd.lng);
      if (!best || km < best.km) best = { from: p, to: d, km };
    }
  }
  return best;
}

type ZoneAdjacency = Map<number, { neighbour: number; connection: ConnectionRow }[]>;

function buildAdjacency(
  connections: ConnectionRow[],
  zoneIds: Set<number>,
): ZoneAdjacency {
  const adjacency: ZoneAdjacency = new Map();
  for (const c of connections) {
    if (!zoneIds.has(c.zone_a_id) || !zoneIds.has(c.zone_b_id)) continue;
    if (!adjacency.has(c.zone_a_id)) adjacency.set(c.zone_a_id, []);
    if (!adjacency.has(c.zone_b_id)) adjacency.set(c.zone_b_id, []);
    adjacency.get(c.zone_a_id)!.push({ neighbour: c.zone_b_id, connection: c });
    adjacency.get(c.zone_b_id)!.push({ neighbour: c.zone_a_id, connection: c });
  }
  return adjacency;
}

function buildGapBridgeCandidates(
  pickupFrontierId: number,
  destFrontierId: number,
  fullAdjacency: ZoneAdjacency,
  allZonesById: Map<number, ZoneMeta>,
  activeZoneIds: Set<number>,
  pickupIdsRaw: Set<number>,
  destIdsRaw: Set<number>,
  isActiveGraphConnected: boolean,
  maxDepth: number,
  extraHops: number,
  now: Date,
): { candidates: GapBridgeCandidate[]; bridge_message: string } {
  const candidateMap = new Map<number, GapBridgeCandidate>();

  const pickupNeighbours = new Set(
    (fullAdjacency.get(pickupFrontierId) ?? []).map((e) => e.neighbour),
  );
  const destNeighbours = new Set(
    (fullAdjacency.get(destFrontierId) ?? []).map((e) => e.neighbour),
  );

  function addCandidate(zoneId: number, onPickup: boolean, onDest: boolean) {
    if (zoneId === pickupFrontierId || zoneId === destFrontierId) return;
    const z = allZonesById.get(zoneId);
    if (!z) return;
    const fields = zoneMetaScheduleFields(z);
    const isActive = activeZoneIds.has(zoneId);
    const inactive = describeZoneScheduleInactiveReason(fields, now);
    candidateMap.set(zoneId, {
      zone_id: z.id,
      zone_name: z.zone_name,
      transport_name: z.transport_name,
      schedule_active: isActive,
      schedule_summary: formatZoneScheduleSummary(fields),
      inactive_reason: isActive ? null : inactive?.label ?? "Not available at this time",
      on_pickup_side: onPickup || pickupNeighbours.has(zoneId),
      on_destination_side: onDest || destNeighbours.has(zoneId),
    });
  }

  for (const id of pickupNeighbours) {
    addCandidate(id, true, destNeighbours.has(id));
  }
  for (const id of destNeighbours) {
    if (!pickupNeighbours.has(id)) addCandidate(id, false, true);
  }

  const fullPickupIds = new Set(
    [...pickupIdsRaw].filter((id) => allZonesById.has(id)),
  );
  const fullDestIds = new Set([...destIdsRaw].filter((id) => allZonesById.has(id)));
  const fullEnumerated = enumerateChains(
    Array.from(fullPickupIds),
    fullDestIds,
    fullAdjacency,
    maxDepth,
    extraHops,
  );
  const fullGraphConnected = fullEnumerated.chains.length > 0;

  if (fullGraphConnected && !isActiveGraphConnected) {
    for (const id of fullEnumerated.zoneIds) {
      if (!activeZoneIds.has(id)) {
        addCandidate(id, pickupNeighbours.has(id), destNeighbours.has(id));
      }
    }
  }

  const candidates = Array.from(candidateMap.values()).sort((a, b) => {
    const aBoth = a.on_pickup_side && a.on_destination_side ? 0 : 1;
    const bBoth = b.on_pickup_side && b.on_destination_side ? 0 : 1;
    if (aBoth !== bBoth) return aBoth - bBoth;
    if (a.schedule_active !== b.schedule_active) return a.schedule_active ? 1 : -1;
    return `${a.transport_name} ${a.zone_name}`.localeCompare(
      `${b.transport_name} ${b.zone_name}`,
    );
  });

  const inactive = candidates.filter((c) => !c.schedule_active);
  const activeNearGap = candidates.filter((c) => c.schedule_active);
  const directBridge = candidates.filter(
    (c) => c.on_pickup_side && c.on_destination_side,
  );

  let bridge_message: string;
  if (candidates.length === 0) {
    bridge_message =
      "No transport zones in the network can bridge this gap — a new zone or connection is required.";
  } else if (inactive.length > 0 && activeNearGap.length === 0) {
    bridge_message =
      inactive.length === 1
        ? "1 zone could bridge this gap but is not available at this date and time."
        : `${inactive.length} zones could bridge this gap but are not available at this date and time.`;
  } else if (inactive.length > 0) {
    bridge_message =
      `${candidates.length} zone${candidates.length === 1 ? "" : "s"} near this gap; ` +
      `${inactive.length} closed at this date & time.`;
  } else if (directBridge.length > 0) {
    bridge_message =
      `${directBridge.length} zone${directBridge.length === 1 ? "" : "s"} connect both sides of the gap but the route is still incomplete — check zone connections.`;
  } else {
    bridge_message =
      `${candidates.length} zone${candidates.length === 1 ? "" : "s"} exist near this gap but do not fully connect pickup to drop-off yet.`;
  }

  return { candidates, bridge_message };
}

/**
 * When no complete route exists, walk the graph from both ends to find:
 *  - how far the order can travel from the pickup side (the incomplete route),
 *  - which destination-side zone gets closest to that frontier,
 *  - the straight-line gap between them and a suggested zone to bridge it.
 */
async function buildGap(
  pickupIds: Set<number>,
  destIds: Set<number>,
  adjacency: ZoneAdjacency,
  zoneById: Map<number, ZoneMeta>,
  maxDepth: number,
  ctx: {
    fullAdjacency: ZoneAdjacency;
    allZonesById: Map<number, ZoneMeta>;
    activeZoneIds: Set<number>;
    pickupIdsRaw: Set<number>;
    destIdsRaw: Set<number>;
    now: Date;
    extraHops: number;
    isActiveGraphConnected: boolean;
  },
): Promise<OrderDraftGap | null> {
  const pickupBfs = bfsFromPickup(Array.from(pickupIds), adjacency, maxDepth);
  const destBfs = bfsFromPickup(Array.from(destIds), adjacency, maxDepth);

  let pickupSide = Array.from(pickupBfs.depth.keys());
  let destSide = Array.from(destBfs.depth.keys());

  // Keep the nearest-pair search bounded: if either frontier is huge, fall
  // back to just the covering zones as anchors.
  if (pickupSide.length + destSide.length > MAX_GAP_CANDIDATES) {
    pickupSide = Array.from(pickupIds);
    destSide = Array.from(destIds);
  }

  // A zone can sit on both frontiers when the only pickup→destination path is
  // longer than the BFS budget (so `enumerateChains` reported "not connected"
  // even though the two sides technically meet). Drop those overlaps from the
  // destination side so the suggested gap is always between two genuinely
  // separated zones — never a misleading 0 km "gap" on the same zone.
  const pickupSet = new Set(pickupSide);
  destSide = destSide.filter((id) => !pickupSet.has(id));
  if (destSide.length === 0) return null;

  const centroidIds = Array.from(new Set([...pickupSide, ...destSide]));
  const centroids = await loadZoneCentroids(centroidIds);
  const pair = nearestZonePair(pickupSide, destSide, centroids);
  if (!pair) return null;

  const pickupChain = reconstructChain(pair.from, pickupBfs);
  const destChainRaw = reconstructChain(pair.to, destBfs);
  // `destChainRaw` runs destination-source → frontier; flip it so the UI can
  // read it as "frontier → … → drop-off".
  const destChain = destChainRaw ? reverseChain(destChainRaw) : null;

  const pickupFrontier = zoneById.get(pair.from);
  const destFrontier = zoneById.get(pair.to);
  const km = Math.round(pair.km * 10) / 10;

  const pickupLabel = pickupFrontier
    ? `${pickupFrontier.transport_name} · ${pickupFrontier.zone_name}`
    : `zone #${pair.from}`;
  const destLabel = destFrontier
    ? `${destFrontier.transport_name} · ${destFrontier.zone_name}`
    : `zone #${pair.to}`;

  const { candidates: bridge_candidates, bridge_message } = buildGapBridgeCandidates(
    pair.from,
    pair.to,
    ctx.fullAdjacency,
    ctx.allZonesById,
    ctx.activeZoneIds,
    ctx.pickupIdsRaw,
    ctx.destIdsRaw,
    ctx.isActiveGraphConnected,
    maxDepth,
    ctx.extraHops,
    ctx.now,
  );

  const message =
    `No complete route yet. From the pickup the order can reach “${pickupLabel}”, ` +
    `which is the closest it gets — about ${km} km from “${destLabel}” on the ` +
    `destination side. ${bridge_message}`;

  return {
    pickup_frontier_zone_id: pair.from,
    destination_frontier_zone_id: pair.to,
    distance_km: km,
    pickup_chain: pickupChain,
    destination_chain: destChain,
    suggested_transport_name: destFrontier?.transport_name ?? pickupFrontier?.transport_name ?? null,
    suggested_zone_name: destFrontier?.zone_name ?? pickupFrontier?.zone_name ?? null,
    message,
    bridge_candidates,
    bridge_message,
  };
}

function describeStatus(
  pickupCount: number,
  destinationCount: number,
  isConnected: boolean,
  connectedCount: number
): { status: OrderConnectionStatus; message: string } {
  if (pickupCount === 0) {
    return {
      status: "no_pickup_zone",
      message:
        "No transport zone covers the pickup location. A driver needs to add a zone over the sender's location first.",
    };
  }
  if (destinationCount === 0) {
    return {
      status: "no_destination_zone",
      message:
        "No transport zone covers the destination location. A driver needs to add a zone over the receiver's location first.",
    };
  }
  if (isConnected) {
    return {
      status: "connected",
      message: `Pickup and destination are linked through ${connectedCount} transport zone${
        connectedCount === 1 ? "" : "s"
      } via land overlap, adjacency, or airport/port hub transfers.`,
    };
  }
  return {
    status: "not_connected",
    message:
      "Pickup and destination zones exist but are not connected on the current zone graph. The order can still be created — it just has no end-to-end zone path yet.",
  };
}

function zoneMetaToSummary(
  z: ZoneMeta,
  isPickup: boolean,
  isDestination: boolean,
  depth: number | null,
  cells: string[]
): OrderDraftZoneSummary {
  return {
    zone_id: z.id,
    zone_name: z.zone_name,
    transport_id: z.owner_user_id,
    transport_name: z.transport_name,
    transport_method: z.transport_mode,
    cell_count: z.cell_count,
    resolution: z.resolution,
    cells,
    is_pickup: isPickup,
    is_destination: isDestination,
    depth,
    departure_hub: z.departure_hub,
    arrival_hub: z.arrival_hub,
    departure_time: z.departure_time,
    arrival_time: z.arrival_time,
    operation_date: z.operation_date,
    operation_start_date: z.operation_start_date,
    operation_end_date: z.operation_end_date,
    schedule_pattern: z.schedule_pattern,
    weekday_start: z.weekday_start,
    weekday_end: z.weekday_end,
    month_day_start: z.month_day_start,
    month_day_end: z.month_day_end,
    operating_start_time: z.operating_start_time,
    operating_end_time: z.operating_end_time,
    base_fee: z.base_fee,
    cost_per_km: z.cost_per_km,
    cost_per_hour: z.cost_per_hour,
    currency: z.currency,
    trust_payment_forwarder: z.trust_payment_forwarder,
    driver_trustworthiness: z.driver_trustworthiness,
  };
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Build the draft zone-network preview for a (pickup, drop-off) coordinate
 * pair. Used by the new-order form ("See zone connections") so the sender
 * can review handoff feasibility before submitting.
 */
export async function previewOrderZoneConnectionsByCoordinates(
  input: OrderDraftPreviewInput
): Promise<OrderDraftPreview> {
  const maxDepth = Math.max(1, Math.min(20, input.max_depth ?? DEFAULT_PREVIEW_MAX_DEPTH));
  const extraHops = Math.max(0, Math.min(6, input.extra_hops ?? DEFAULT_EXTRA_HOPS));
  // Display-only resolution: scale the pickup / drop-off cell size to the
  // distance between them so the hexagons stay visible when the map fits
  // both ends. Persisted order H3 still uses ORDER_H3_RESOLUTION elsewhere.
  const distanceKm = haversineKm(
    input.source_lat,
    input.source_lng,
    input.destination_lat,
    input.destination_lng
  );
  const resolution = pickPreviewResolution(distanceKm);

  const sourceH3 = latLngToCell(input.source_lat, input.source_lng, resolution);
  const destinationH3 = latLngToCell(input.destination_lat, input.destination_lng, resolution);

  // Run zone-meta load, connection load, and the two SQL covering checks in
  // parallel — none of them depend on each other and each is a single
  // round-trip, so wall-time should be dominated by the slowest.
  const [allZones, allConnections, pickupIdsRaw, destIdsRaw] = await Promise.all([
    loadAllAvailableZoneMeta(),
    loadConnections(),
    findCoveringZoneIdsSql(input.source_lat, input.source_lng),
    findCoveringZoneIdsSql(input.destination_lat, input.destination_lng),
  ]);

  const now = resolveScheduleAt(input.schedule_at);
  const zones = allZones.filter((z) => isZoneScheduleActive(zoneMetaScheduleFields(z), now));
  const allZonesById = new Map(allZones.map((z) => [z.id, z]));
  const activeZoneIds = new Set(zones.map((z) => z.id));
  const scheduleInactiveZones = buildScheduleInactiveZones(
    pickupIdsRaw,
    destIdsRaw,
    activeZoneIds,
    allZonesById,
    now,
  );

  const pickupIds = new Set([...pickupIdsRaw].filter((id) => activeZoneIds.has(id)));
  const destIds = new Set([...destIdsRaw].filter((id) => activeZoneIds.has(id)));

  // Only walk through zones we actually loaded (i.e. `available = TRUE`).
  // Stale connection rows pointing at unavailable zones must not let BFS
  // claim a path that the UI can't render.
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const fullZoneById = new Map(allZones.map((z) => [z.id, z]));
  const fullZoneIdSet = new Set(fullZoneById.keys());
  const fullConnections = allConnections.filter(
    (c) => fullZoneIdSet.has(c.zone_a_id) && fullZoneIdSet.has(c.zone_b_id),
  );
  const fullAdjacency = buildAdjacency(fullConnections, fullZoneIdSet);

  const connections = allConnections.filter(
    (c) => zoneById.has(c.zone_a_id) && zoneById.has(c.zone_b_id)
  );

  // Drop covering zone ids that aren't in the available set (paranoia: SQL
  // already filtered, but the meta query could in theory disagree).
  pickupIds.forEach((id) => {
    if (!zoneById.has(id)) pickupIds.delete(id);
  });
  destIds.forEach((id) => {
    if (!zoneById.has(id)) destIds.delete(id);
  });

  const adjacency = buildAdjacency(
    connections,
    new Set(zoneById.keys()),
  );

  const pickupZones = pickZones(pickupIds, zoneById);
  const destinationZones = pickZones(destIds, zoneById);
  // Depth (distance from the nearest pickup) is still useful for ordering /
  // labelling each zone, so we keep the cheap BFS for that.
  const bfs = bfsFromPickup(Array.from(pickupIds), adjacency, maxDepth);
  // …but the actual routes shown to the sender now come from full path
  // enumeration so *every* reasonable pickup→destination chain is surfaced.
  const enumerated = enumerateChains(
    Array.from(pickupIds),
    destIds,
    adjacency,
    maxDepth,
    extraHops
  );
  const chains = enumerated.chains;
  const usedConnectionIds = enumerated.usedConnectionIds;
  const isConnected = chains.length > 0;

  // Milestone 4 — when there is no complete route but both ends have a
  // covering zone, reconstruct the incomplete routes from each side and the
  // nearest gap a new/extended zone would need to close.
  const gap =
    !isConnected && pickupIds.size > 0 && destIds.size > 0
      ? await buildGap(pickupIds, destIds, adjacency, zoneById, maxDepth, {
          fullAdjacency,
          allZonesById,
          activeZoneIds,
          pickupIdsRaw,
          destIdsRaw,
          now,
          extraHops,
          isActiveGraphConnected: isConnected,
        })
      : null;

  // Surface pickup + destination zones plus every zone that appears on a
  // possible route. We deliberately do NOT surface all BFS-reachable zones
  // anymore — only the ones the sender could actually be routed through. When
  // there's no full route we also surface the incomplete-route zones so the
  // map can trace how far each side reaches.
  const surfacedIds = new Set<number>();
  pickupIds.forEach((id) => surfacedIds.add(id));
  destIds.forEach((id) => surfacedIds.add(id));
  enumerated.zoneIds.forEach((id) => surfacedIds.add(id));
  if (gap) {
    gap.pickup_chain?.zone_ids.forEach((id) => surfacedIds.add(id));
    gap.destination_chain?.zone_ids.forEach((id) => surfacedIds.add(id));
  }
  const cellsByZone = await loadCellsForZoneIds(Array.from(surfacedIds));

  const summaryById = new Map<number, OrderDraftZoneSummary>();
  function add(zoneId: number) {
    if (summaryById.has(zoneId)) return;
    const z = zoneById.get(zoneId);
    if (!z) return;
    const depth = bfs.depth.has(zoneId) ? bfs.depth.get(zoneId)! : null;
    summaryById.set(
      zoneId,
      zoneMetaToSummary(
        z,
        pickupIds.has(zoneId),
        destIds.has(zoneId),
        depth,
        cellsByZone.get(zoneId) ?? []
      )
    );
  }
  surfacedIds.forEach(add);

  const connectionList: OrderDraftConnection[] = [];
  const transferCellSet = new Set<string>();
  for (const c of connections) {
    if (!summaryById.has(c.zone_a_id) || !summaryById.has(c.zone_b_id)) continue;
    const used = usedConnectionIds.has(c.id);
    connectionList.push({
      id: c.id,
      from_zone_id: c.zone_a_id,
      to_zone_id: c.zone_b_id,
      connection_type: c.connection_type,
      transfer_cells: c.transfer_cells,
      adjacent_cell_pairs: c.adjacent_cell_pairs,
      used_in_preview: used,
      hub_role_a: c.hub_role_a,
      hub_role_b: c.hub_role_b,
    });
    if (used) c.transfer_cells.forEach((cell) => transferCellSet.add(cell));
  }
  connectionList.sort((a, b) =>
    a.used_in_preview === b.used_in_preview ? a.id - b.id : a.used_in_preview ? -1 : 1
  );

  const { status, message } = describeStatus(
    pickupZones.length,
    destinationZones.length,
    isConnected,
    summaryById.size
  );

  const pickupZoneSummaries = pickupZones
    .map((z) => summaryById.get(z.id))
    .filter((s): s is OrderDraftZoneSummary => Boolean(s));
  const destinationZoneSummaries = destinationZones
    .map((z) => summaryById.get(z.id))
    .filter((s): s is OrderDraftZoneSummary => Boolean(s));

  return {
    source: {
      name: input.source_name?.trim() || "Pickup",
      address: input.source_address?.trim() || "",
      lat: input.source_lat,
      lng: input.source_lng,
      h3: sourceH3,
    },
    destination: {
      name: input.destination_name?.trim() || "Destination",
      address: input.destination_address?.trim() || "",
      lat: input.destination_lat,
      lng: input.destination_lng,
      h3: destinationH3,
    },
    preview_resolution: resolution,
    max_depth: maxDepth,
    pickup_zones: pickupZoneSummaries,
    destination_zones: destinationZoneSummaries,
    connected_zones: Array.from(summaryById.values()).sort((a, b) => {
      const da = a.depth ?? Number.MAX_SAFE_INTEGER;
      const db = b.depth ?? Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      return a.zone_name.localeCompare(b.zone_name);
    }),
    connections: connectionList,
    transfer_cells: Array.from(transferCellSet),
    is_connected_to_destination: isConnected,
    status,
    message,
    possible_connection_chains: chains,
    gap,
    schedule_inactive_zones: scheduleInactiveZones,
  };
}

/**
 * Zone-connection preview for an existing order. Uses `getOrderById` access
 * rules so transporters with a segment on the order can view route geometry
 * (e.g. quote-request maps) without using the draft-only coordinate endpoint.
 */
export async function previewOrderZoneConnectionsForOrder(
  orderId: number,
  ctx: OrderContext
): Promise<OrderDraftPreview> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderError("Order not found", 404);

  const { sender_lat, sender_lng, destination_lat, destination_lng } = order;
  if (
    sender_lat == null ||
    sender_lng == null ||
    destination_lat == null ||
    destination_lng == null
  ) {
    throw new OrderError("Order is missing pickup or delivery coordinates", 400);
  }

  return previewOrderZoneConnectionsByCoordinates({
    source_lat: sender_lat,
    source_lng: sender_lng,
    destination_lat,
    destination_lng,
    source_name: order.source_name || order.sender_name,
    source_address: order.sender_address,
    destination_name: order.receiver_name,
    destination_address: order.destination_address,
    max_depth: DEFAULT_PREVIEW_MAX_DEPTH,
    schedule_at: order.route_schedule_at ?? undefined,
  });
}
