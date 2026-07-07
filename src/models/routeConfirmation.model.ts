import type { TrackingStatus } from "./orderTracking.model";
import type { ScheduleInactiveZoneSummary, SegmentCostStatus } from "./routeCost.model";

export const ROUTE_SELECTION_STATUSES = [
  "pending",
  "confirmed",
  "rejected",
  "partially_confirmed",
] as const;
export type RouteSelectionStatus = (typeof ROUTE_SELECTION_STATUSES)[number];

export const PAYMENT_STATUSES = ["pending", "ready", "not_required"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ROUTE_PURPOSES = ["standard", "payment", "goods"] as const;
export type RoutePurpose = (typeof ROUTE_PURPOSES)[number];

export const SEGMENT_LEG_STATUSES = ["not_started", "picked_up", "in_transit"] as const;
export type SegmentLegStatus = (typeof SEGMENT_LEG_STATUSES)[number];

export function isSegmentLegStatus(value: unknown): value is SegmentLegStatus {
  return typeof value === "string" && (SEGMENT_LEG_STATUSES as readonly string[]).includes(value);
}

export const SEGMENT_CONFIRMATION_STATUSES = ["pending", "accepted", "rejected"] as const;
export type SegmentConfirmationStatus = (typeof SEGMENT_CONFIRMATION_STATUSES)[number];

export const CONFIRMATION_REQUEST_STATUSES = ["sent", "accepted", "rejected", "expired"] as const;
export type ConfirmationRequestStatus = (typeof CONFIRMATION_REQUEST_STATUSES)[number];

export interface RouteSelectionRow {
  id: number;
  order_id: number;
  selected_route_id: number;
  selected_by_user_id: number;
  status: RouteSelectionStatus;
  payment_status: PaymentStatus;
  route_purpose: RoutePurpose;
  created_at: Date;
  updated_at: Date;
}

export interface SegmentConfirmationRow {
  id: number;
  route_id: number;
  segment_id: number;
  transporter_id: number;
  status: SegmentConfirmationStatus;
  leg_status: SegmentLegStatus;
  rejection_reason: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

export type PffLegPhase = "payment" | "goods";

export interface SegmentConfirmationDetail {
  segment_id: number;
  segment_index: number;
  transporter_id: number;
  transporter_name: string;
  from_node_id: string;
  from_label: string;
  to_node_id: string;
  to_label: string;
  leg_phase?: PffLegPhase | null;
  status: SegmentConfirmationStatus;
  leg_status: SegmentLegStatus;
  rejection_reason: string | null;
  confirmed_at: string | null;
  final_cost: number | null;
  currency: string;
}

export interface RouteConfirmationStatusResponse {
  route_id: number;
  order_id: number;
  route_label: string;
  selection_status: RouteSelectionStatus;
  payment_status: PaymentStatus;
  confirmed_count: number;
  pending_count: number;
  rejected_count: number;
  total_segments: number;
  progress_percent: number;
  segments: SegmentConfirmationDetail[];
}

export interface RouteSelectionResponse {
  id: number;
  order_id: number;
  selected_route_id: number;
  selected_by_user_id: number;
  status: RouteSelectionStatus;
  payment_status: PaymentStatus;
  route_purpose: RoutePurpose;
  route_label: string;
  created_at: string;
  updated_at: string;
}

export interface PffRouteSelectionsResponse {
  payment: RouteSelectionResponse | null;
  goods: RouteSelectionResponse | null;
  both_confirmed: boolean;
}

export interface TransporterConfirmationItem {
  confirmation_id: number;
  route_id: number;
  order_id: number;
  segment_id: number;
  segment_index: number;
  leg_phase?: PffLegPhase | null;
  handoff_role?: import("./routeCost.model").PffHandoffRole | null;
  from_label: string;
  to_label: string;
  status: SegmentConfirmationStatus;
  leg_status: SegmentLegStatus;
  rejection_reason: string | null;
  route_label: string;
  sender_address: string;
  destination_address: string;
  sent_at: string;
  route_selection_status: RouteSelectionStatus | null;
  order_tracking_status: TrackingStatus;
  pickup_ready_at: string | null;
  goods_ready_at: string | null;
  payment_method: string;
  route_segment_count: number;
  previous_leg_status: SegmentLegStatus | null;
  final_cost: number | null;
  currency: string;
  cost_status: SegmentCostStatus;
  package_type: string | null;
  package_weight_lbs: number | null;
  package_dimensions_in: string | null;
  route_is_complete: boolean;
  schedule_inactive_zones: ScheduleInactiveZoneSummary[];
  zone_id: number | null;
  zone_schedule_active: boolean | null;
  zone_schedule_summary: string | null;
  zone_schedule_inactive_reason: string | null;
}
