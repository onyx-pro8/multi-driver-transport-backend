import { gridDistance, latLngToCell } from "h3-js";
import type {
  SegmentCostBreakdown,
  SegmentCostSource,
  SegmentCostStatus,
} from "../models/routeCost.model";
import type { OrderResponse } from "../models/order.model";
import { packageFactorForType, totalPackageFactorForEntries, type PackageType, type OrderPackageEntry } from "../models/package.model";
import { DEFAULT_BOOKING_FEE_RATE, DEFAULT_LAND_SPEED_KMH } from "../models/pricing.model";
import type { ZonePricingMode } from "../models/pricingRegion.model";
import { ORDER_H3_RESOLUTION } from "./order.service";

export type PffLegPhase = "payment" | "goods";
export type PffHandoffRole = "payment_delivery" | "goods_pickup";

export interface DerivedSegment {
  segment_index: number;
  transporter_id: number;
  from_node_id: string;
  to_node_id: string;
  transport_method: string;
  from_zone_id: number | null;
  to_zone_id: number | null;
  zone_ids: number[];
  /** PFF payment route: receiver → sender (receiver sends payment to producer). */
  /** PFF goods route: sender → receiver. */
  leg_phase?: PffLegPhase | null;
  /** Producer handoff: same transporter delivers payment then collects goods. */
  handoff_role?: PffHandoffRole | null;
  /** Index of the priced zone in the original forward zone chain. */
  forward_zone_index: number;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function haversineKm(
  lat1: number | null,
  lng1: number | null,
  lat2: number | null,
  lng2: number | null
): number | null {
  if (
    lat1 == null ||
    lng1 == null ||
    lat2 == null ||
    lng2 == null ||
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return roundMoney(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function isLineMode(method: string): boolean {
  return method === "air" || method === "sea";
}

export function calculateSegmentDistanceH3(
  fromLat: number | null,
  fromLng: number | null,
  toLat: number | null,
  toLng: number | null,
  resolution = ORDER_H3_RESOLUTION
): { distance_h3_cells: number | null; distance_km: number | null } {
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
    return { distance_h3_cells: null, distance_km: null };
  }
  try {
    const fromCell = latLngToCell(fromLat, fromLng, resolution);
    const toCell = latLngToCell(toLat, toLng, resolution);
    const cells = gridDistance(fromCell, toCell);
    const kmPerCell = resolution <= 4 ? 22 : resolution <= 6 ? 3.2 : resolution <= 8 ? 0.46 : 0.17;
    return {
      distance_h3_cells: cells,
      distance_km: roundMoney(cells * kmPerCell),
    };
  } catch {
    return { distance_h3_cells: null, distance_km: null };
  }
}

/** Pricing rules sourced from the segment's zone. */
export interface SegmentRate {
  currency: string;
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
}

export interface SegmentCostInput {
  segment: DerivedSegment;
  order: Pick<
    OrderResponse,
    | "package_type"
    | "packages"
    | "package_factor"
    | "sender_lat"
    | "sender_lng"
    | "destination_lat"
    | "destination_lng"
  >;
  rate: SegmentRate | null;
  zoneCoords: Map<number, { lat: number; lng: number; transport_method: string | null }>;
  lineDistanceKm?: number | null;
  /** Zone schedule times used for waiting-cost (hours). */
  departureTime?: string | null;
  arrivalTime?: string | null;
  distanceOverride?: {
    distance_h3_cells: number | null;
    distance_km: number | null;
    /** Road routing duration (e.g. Google Directions) when zone schedule is absent. */
    duration_hours?: number | null;
  };
  packageFactor?: number;
  bookingFeeRate?: number;
  landSpeedKmh?: number;
  /** When "manual", the transporter sets cost per route — skip auto-calculation. */
  pricingMode?: ZonePricingMode;
}

export interface SegmentCostResult {
  package_factor: number | null;
  distance_h3_cells: number | null;
  distance_km: number | null;
  time_hours: number | null;
  base_fee: number | null;
  distance_cost: number | null;
  waiting_cost: number | null;
  booking_fee: number | null;
  weight_cost: null;
  volume_cost: null;
  time_factor_amount: null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
  cost_source: SegmentCostSource | null;
  currency: string;
  calculation_breakdown: SegmentCostBreakdown | null;
}

/** AIR segments never auto-calculate; SEA/LAND may when rates are configured. */
export function transportAllowsAutoCost(transportMethod: string): boolean {
  return transportMethod !== "air";
}

export function transportRequiresCostRequest(transportMethod: string): boolean {
  return transportMethod === "air";
}

export function calculatePackageFactor(
  packageType: PackageType | null | undefined,
  explicitFactor: number | null | undefined,
  packages?: readonly OrderPackageEntry[] | null
): number {
  if (explicitFactor != null && Number.isFinite(explicitFactor) && explicitFactor > 0) {
    return explicitFactor;
  }
  if (packages && packages.length > 0) {
    return totalPackageFactorForEntries(packages);
  }
  if (packageType) {
    return packageFactorForType(packageType);
  }
  return packageFactorForType("medium");
}

export function calculateBaseCost(rate: SegmentRate | null): number {
  return Number(rate?.base_fee ?? 0);
}

export function calculateTravelCost(distanceKm: number | null, ratePerKm: number | null): number {
  if (distanceKm == null || ratePerKm == null) return 0;
  return distanceKm * ratePerKm;
}

/**
 * Waiting cost = time (hours) × wage (cost per hour).
 * Time is derived from zone departure/arrival schedule (HH:MM).
 */
export function scheduleDurationHours(
  departureTime: string | null | undefined,
  arrivalTime: string | null | undefined
): number | null {
  if (!departureTime || !arrivalTime) return null;
  const depMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(departureTime.trim());
  const arrMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(arrivalTime.trim());
  if (!depMatch || !arrMatch) return null;
  const depMinutes = Number(depMatch[1]) * 60 + Number(depMatch[2]);
  let arrMinutes = Number(arrMatch[1]) * 60 + Number(arrMatch[2]);
  if (arrMinutes < depMinutes) arrMinutes += 24 * 60;
  return roundMoney((arrMinutes - depMinutes) / 60);
}

export function estimateLandTransitHours(
  distanceKm: number | null,
  landSpeedKmh = DEFAULT_LAND_SPEED_KMH
): number | null {
  if (distanceKm == null || distanceKm <= 0 || landSpeedKmh <= 0) return null;
  return roundMoney(distanceKm / landSpeedKmh);
}

/**
 * Waiting/transit hours: zone schedule first; for land, estimate from distance when absent.
 */
export function resolveSegmentTimeHours(
  transportMethod: string,
  departureTime: string | null | undefined,
  arrivalTime: string | null | undefined,
  distanceKm: number | null,
  landSpeedKmh = DEFAULT_LAND_SPEED_KMH,
  roadDurationHours?: number | null
): number | null {
  const scheduled = scheduleDurationHours(departureTime, arrivalTime);
  if (scheduled != null) return scheduled;
  if (roadDurationHours != null && Number.isFinite(roadDurationHours)) {
    return roundMoney(roadDurationHours);
  }
  if (transportMethod === "land") {
    return estimateLandTransitHours(distanceKm, landSpeedKmh);
  }
  return null;
}

export function calculateWaitingCost(timeHours: number | null, wagePerHour: number | null): number {
  if (timeHours == null || wagePerHour == null) return 0;
  return timeHours * wagePerHour;
}

export function calculateBookingFee(subTotal: number, rate = DEFAULT_BOOKING_FEE_RATE): number {
  return subTotal * rate;
}

export function calculateTotalCost(
  adjustedBase: number,
  travellingCost: number,
  waitingCost: number,
  bookingFeeRate = DEFAULT_BOOKING_FEE_RATE
): { subTotal: number; bookingFee: number; total: number } {
  const subTotal = adjustedBase + travellingCost + waitingCost;
  const bookingFee = calculateBookingFee(subTotal, bookingFeeRate);
  return {
    subTotal: roundMoney(subTotal),
    bookingFee: roundMoney(bookingFee),
    total: roundMoney(subTotal + bookingFee),
  };
}

function resolveDistanceKm(
  segment: DerivedSegment,
  order: SegmentCostInput["order"],
  zoneCoords: SegmentCostInput["zoneCoords"],
  lineDistanceKm: number | null | undefined,
  distanceOverride: SegmentCostInput["distanceOverride"]
): { distanceKm: number | null; distanceCells: number | null } {
  let distanceKm = distanceOverride?.distance_km ?? null;
  const distanceCells = distanceOverride?.distance_h3_cells ?? null;

  if (distanceKm == null) {
    const line = isLineMode(segment.transport_method);
    if (line) {
      distanceKm = lineDistanceKm ?? null;
    }
    if (distanceKm == null) {
      const from = resolveCoords(segment.from_node_id, order, zoneCoords);
      const to = resolveCoords(segment.to_node_id, order, zoneCoords);
      const dist = calculateSegmentDistanceH3(from.lat, from.lng, to.lat, to.lng);
      distanceKm = dist.distance_km;
    }
  }

  return { distanceKm, distanceCells };
}

function resolveCoords(
  nodeId: string,
  order: SegmentCostInput["order"],
  zoneCoords: SegmentCostInput["zoneCoords"]
): { lat: number | null; lng: number | null } {
  if (nodeId === "sender") {
    return { lat: order.sender_lat, lng: order.sender_lng };
  }
  if (nodeId === "receiver") {
    return { lat: order.destination_lat, lng: order.destination_lng };
  }
  const zoneId = Number(nodeId);
  if (Number.isFinite(zoneId)) {
    const z = zoneCoords.get(zoneId);
    if (z) return { lat: z.lat, lng: z.lng };
  }
  return { lat: null, lng: null };
}

function rateIsConfigured(rate: SegmentRate | null): boolean {
  if (!rate) return false;
  return (
    rate.base_fee != null || rate.cost_per_km != null || rate.cost_per_hour != null
  );
}

function emptyResult(
  status: SegmentCostStatus,
  currency: string,
  packageFactor: number | null
): SegmentCostResult {
  return {
    package_factor: packageFactor,
    distance_h3_cells: null,
    distance_km: null,
    time_hours: null,
    base_fee: null,
    distance_cost: null,
    waiting_cost: null,
    booking_fee: null,
    weight_cost: null,
    volume_cost: null,
    time_factor_amount: null,
    calculated_cost: null,
    manual_cost: null,
    final_cost: null,
    cost_status: status,
    cost_source: null,
    currency,
    calculation_breakdown: null,
  };
}

export function calculateSegmentCost(input: SegmentCostInput): SegmentCostResult {
  const { segment, order, rate, zoneCoords } = input;
  const currency = rate?.currency ?? "CAD";
  const packageFactor = calculatePackageFactor(
    order.package_type,
    input.packageFactor ?? order.package_factor,
    order.packages
  );
  const bookingFeeRate = input.bookingFeeRate ?? DEFAULT_BOOKING_FEE_RATE;
  const method = segment.transport_method;

  if (transportRequiresCostRequest(method)) {
    return emptyResult("requested", currency, packageFactor);
  }

  if (input.pricingMode === "manual") {
    return emptyResult("requested", currency, packageFactor);
  }

  if (!rateIsConfigured(rate)) {
    return emptyResult(method === "sea" ? "requested" : "missing", currency, packageFactor);
  }

  const baseCost = calculateBaseCost(rate);
  const adjustedBase = roundMoney(baseCost * packageFactor);

  const { distanceKm, distanceCells } = resolveDistanceKm(
    segment,
    order,
    zoneCoords,
    input.lineDistanceKm,
    input.distanceOverride
  );

  const timeHours = resolveSegmentTimeHours(
    method,
    input.departureTime,
    input.arrivalTime,
    distanceKm,
    input.landSpeedKmh ?? DEFAULT_LAND_SPEED_KMH,
    input.distanceOverride?.duration_hours
  );
  const travellingCost = roundMoney(calculateTravelCost(distanceKm, rate?.cost_per_km ?? null));
  const waitingCost = roundMoney(calculateWaitingCost(timeHours, rate?.cost_per_hour ?? null));

  const { subTotal, bookingFee, total } = calculateTotalCost(
    adjustedBase,
    travellingCost,
    waitingCost,
    bookingFeeRate
  );

  const breakdown: SegmentCostBreakdown = {
    base_cost: roundMoney(baseCost),
    package_factor: packageFactor,
    adjusted_base_cost: adjustedBase,
    travelling_cost: travellingCost,
    waiting_cost: waitingCost,
    sub_total: subTotal,
    booking_fee_rate: bookingFeeRate,
    booking_fee: bookingFee,
    total_cost: total,
  };

  return {
    package_factor: packageFactor,
    distance_h3_cells: distanceCells,
    distance_km: distanceKm,
    time_hours: timeHours,
    base_fee: breakdown.base_cost,
    distance_cost: travellingCost,
    waiting_cost: waitingCost,
    booking_fee: bookingFee,
    weight_cost: null,
    volume_cost: null,
    time_factor_amount: null,
    calculated_cost: total,
    manual_cost: null,
    final_cost: total,
    cost_status: "calculated",
    cost_source: "calculated",
    currency,
    calculation_breakdown: breakdown,
  };
}

function deriveForwardSegments(
  zoneIds: number[],
  zoneMeta: Map<number, { owner_user_id: number; transport_mode: string | null }>,
  options: {
    indexOffset: number;
    legPhase: PffLegPhase | null;
    startNode: "sender" | "receiver";
    endNode: "sender" | "receiver";
  },
): DerivedSegment[] {
  const segments: DerivedSegment[] = [];
  for (let i = 0; i < zoneIds.length; i++) {
    const zoneId = zoneIds[i];
    const meta = zoneMeta.get(zoneId);
    if (!meta) continue;
    const method = meta.transport_mode ?? "land";
    const fromNode = i === 0 ? options.startNode : String(zoneIds[i - 1]);
    const toNode = i === zoneIds.length - 1 ? options.endNode : String(zoneId);

    const isGoodsHandoff =
      options.legPhase === "goods" && i === 0 && options.startNode === "sender";
    const isPaymentHandoff =
      options.legPhase === "payment" &&
      i === zoneIds.length - 1 &&
      options.endNode === "sender";

    segments.push({
      segment_index: options.indexOffset + segments.length,
      transporter_id: meta.owner_user_id,
      from_node_id: fromNode,
      to_node_id: toNode,
      transport_method: method,
      from_zone_id: zoneId,
      to_zone_id: zoneId,
      zone_ids: [zoneId],
      leg_phase: options.legPhase,
      handoff_role: isPaymentHandoff
        ? "payment_delivery"
        : isGoodsHandoff
          ? "goods_pickup"
          : null,
      forward_zone_index: i,
    });
  }
  return segments;
}

export type RouteSegmentPurpose = "standard" | "payment" | "goods";

export function deriveSegmentsFromRoute(
  zoneIds: number[],
  zoneMeta: Map<number, { owner_user_id: number; transport_mode: string | null }>,
  routePurpose: RouteSegmentPurpose = "standard",
): DerivedSegment[] {
  if (zoneIds.length === 0) return [];

  if (routePurpose === "payment") {
    return deriveForwardSegments(zoneIds, zoneMeta, {
      indexOffset: 0,
      legPhase: "payment",
      startNode: "receiver",
      endNode: "sender",
    });
  }

  if (routePurpose === "goods") {
    return deriveForwardSegments(zoneIds, zoneMeta, {
      indexOffset: 0,
      legPhase: "goods",
      startNode: "sender",
      endNode: "receiver",
    });
  }

  return deriveForwardSegments(zoneIds, zoneMeta, {
    indexOffset: 0,
    legPhase: null,
    startNode: "sender",
    endNode: "receiver",
  });
}

/** @deprecated Legacy doubled-route PFF — use separate payment/goods routes instead. */
function deriveReversePaymentSegments(
  zoneIds: number[],
  zoneMeta: Map<number, { owner_user_id: number; transport_mode: string | null }>,
  indexOffset: number,
): DerivedSegment[] {
  const segments: DerivedSegment[] = [];
  const n = zoneIds.length;
  for (let i = 0; i < n; i++) {
    const forwardIndex = n - 1 - i;
    const zoneId = zoneIds[forwardIndex];
    const meta = zoneMeta.get(zoneId);
    if (!meta) continue;
    const method = meta.transport_mode ?? "land";
    const fromNode = i === 0 ? "receiver" : String(zoneIds[n - i]);
    const toNode = i === n - 1 ? "sender" : String(zoneIds[n - i - 1]);

    const isPaymentHandoff = i === n - 1;

    segments.push({
      segment_index: indexOffset + segments.length,
      transporter_id: meta.owner_user_id,
      from_node_id: fromNode,
      to_node_id: toNode,
      transport_method: method,
      from_zone_id: zoneId,
      to_zone_id: zoneId,
      zone_ids: [zoneId],
      leg_phase: "payment",
      handoff_role: isPaymentHandoff ? "payment_delivery" : null,
      forward_zone_index: forwardIndex,
    });
  }
  return segments;
}

export function expectedSegmentCountForRoute(
  zoneCount: number,
  _legacyIsPff = false,
): number {
  if (zoneCount === 0) return 0;
  return zoneCount;
}
