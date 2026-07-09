export type SegmentCostStatus = "calculated" | "manual" | "missing" | "requested";
export type SegmentCostSource = "calculated" | "manual" | "external";
export type RouteCostStatus = "complete" | "partial" | "missing";

import type { OrderPackageEntry } from "./package.model";

export interface OrderRouteRow {
  id: number;
  order_id: number;
  route_label: string;
  route_index: number;
  zone_ids: number[];
  connection_ids: number[];
  transporter_ids: number[];
  is_complete: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SegmentCostBreakdown {
  base_cost: number;
  package_factor: number;
  adjusted_base_cost: number;
  travelling_cost: number;
  waiting_cost: number;
  sub_total: number;
  booking_fee_rate: number;
  booking_fee: number;
  total_cost: number;
}

export interface RouteSegmentCostRow {
  id: number;
  route_id: number;
  segment_index: number;
  transporter_id: number;
  from_node_id: string;
  to_node_id: string;
  transport_method: string;
  package_weight: number | null;
  package_volume: number | null;
  distance_h3_cells: number | null;
  distance_km: number | null;
  time_hours: number | null;
  package_factor: number | null;
  base_fee: number | null;
  weight_cost: number | null;
  volume_cost: number | null;
  distance_cost: number | null;
  waiting_cost: number | null;
  booking_fee: number | null;
  time_factor_amount: number | null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
  cost_source: SegmentCostSource | null;
  currency: string;
  calculation_breakdown: SegmentCostBreakdown | null;
  created_at: Date;
  updated_at: Date;
}

export interface RouteCostSummaryRow {
  id: number;
  route_id: number;
  order_id: number;
  total_calculated_cost: number | null;
  total_manual_cost: number | null;
  total_final_cost: number | null;
  missing_segment_count: number;
  requested_segment_count: number;
  currency: string;
  status: RouteCostStatus;
  created_at: Date;
  updated_at: Date;
}

export type PffLegPhase = "payment" | "goods";
export type PffHandoffRole = "payment_delivery" | "goods_pickup";

export interface RouteSegmentCostResponse {
  segment_id: number;
  segment_index: number;
  transporter_id: number;
  transporter_name: string;
  from_node_id: string;
  from_label: string;
  to_node_id: string;
  to_label: string;
  leg_phase?: PffLegPhase | null;
  handoff_role?: PffHandoffRole | null;
  transport_method: string;
  /** Zone that owns pricing for this segment (from_node when it is a zone id). */
  zone_id: number | null;
  zone_pricing_mode: import("./pricingRegion.model").ZonePricingMode | null;
  pricing_region_name: string | null;
  effective_base_fee: number | null;
  effective_cost_per_km: number | null;
  effective_cost_per_hour: number | null;
  distance_h3_cells: number | null;
  distance_km: number | null;
  time_hours: number | null;
  package_factor: number | null;
  base_fee: number | null;
  distance_cost: number | null;
  waiting_cost: number | null;
  booking_fee: number | null;
  weight_cost: number | null;
  volume_cost: number | null;
  time_factor_amount: number | null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
  cost_source: SegmentCostSource | null;
  currency: string;
  breakdown: SegmentCostBreakdown | null;
}

export type RoutePurpose = "payment" | "goods" | null;

export interface RouteCostSummaryResponse {
  route_id: number;
  order_id: number;
  route_label: string;
  route_purpose?: RoutePurpose;
  transporters: string[];
  segment_count: number;
  total_calculated_cost: number | null;
  total_manual_cost: number | null;
  total_final_cost: number | null;
  missing_segment_count: number;
  requested_segment_count: number;
  currency: string;
  status: RouteCostStatus;
  segments: RouteSegmentCostResponse[];
  /** PFF: cannot select — the other route already uses air/sea. */
  pff_selection_blocked?: boolean;
  pff_selection_blocked_reason?: string | null;
}

export interface ScheduleInactiveZoneSummary {
  zone_id: number;
  zone_name: string;
  transport_name: string;
  schedule_summary: string | null;
  inactive_reason: string | null;
  covers: "pickup" | "destination" | "both";
}

export interface GapBridgeCandidateSummary {
  zone_id: number;
  zone_name: string;
  transport_name: string;
  schedule_active: boolean;
  schedule_summary: string | null;
  inactive_reason: string | null;
  on_pickup_side: boolean;
  on_destination_side: boolean;
}

export interface OrderDraftGapSummary {
  distance_km: number | null;
  bridge_message: string | null;
  bridge_candidates: GapBridgeCandidateSummary[];
  message: string;
}

export interface OrderRouteCostComparisonResponse {
  order_id: number;
  currency: string;
  booking_fee_rate: number;
  pff_factor: number;
  is_pff_order: boolean;
  package_type: string | null;
  packages: OrderPackageEntry[];
  package_factor: number | null;
  package_weight_lbs: number | null;
  package_dimensions_in: string | null;
  routes: RouteCostSummaryResponse[];
  /** PFF: receiver→sender payment route options. */
  payment_routes?: RouteCostSummaryResponse[];
  /** PFF: sender→receiver goods route options. */
  goods_routes?: RouteCostSummaryResponse[];
  route_locked: boolean;
  route_lock_reason: "confirmed_route" | "confirmation_pending" | "delivery_in_progress" | null;
  schedule_inactive_zones: ScheduleInactiveZoneSummary[];
  route_schedule_at: string | null;
  is_route_complete: boolean;
  is_payment_route_complete?: boolean;
  is_goods_route_complete?: boolean;
  gap: OrderDraftGapSummary | null;
}

export interface AffectedRouteRef {
  route_id: number;
  route_label: string;
}

/** Pending segment cost work for a transporter (quote requested or missing rates). */
export interface TransporterQuoteRequestItem {
  order_id: number;
  order_status: string;
  sender_address: string;
  sender_lat: number | null;
  sender_lng: number | null;
  destination_address: string;
  destination_lat: number | null;
  destination_lng: number | null;
  package_type: string | null;
  package_weight_lbs: number | null;
  package_dimensions_in: string | null;
  /** Driver zone this quote applies to (dedup key with order + transporter). */
  priced_zone_id: number;
  /** Primary route used for map geometry (first affected route). */
  route_id: number;
  route_label: string;
  zone_ids: number[];
  connection_ids: number[];
  /** All route alternatives that include this same priced segment. */
  affected_routes: AffectedRouteRef[];
  /** All `route_segment_costs` rows updated when a quote is saved. */
  segment_ids: number[];
  segment: RouteSegmentCostResponse;
  updated_at: string;
}

/** Segment still needs a price entered (missing rates or air quote pending). */
export function segmentNeedsCostEntry(status: SegmentCostStatus): boolean {
  return status === "missing" || status === "requested";
}

/** Only `missing` should trigger automatic recalculation (not stable `requested`). */
export function segmentNeedsRecalculation(status: SegmentCostStatus): boolean {
  return status === "missing";
}
