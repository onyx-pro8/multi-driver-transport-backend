export const TRACKING_STATUSES = [
  "AWAITING_CONNECT",
  "REJECTED",
  "CONFIRMED",
  "PICKUP_AVAILABLE",
  "PICKED_UP",
  "IN_TRANSIT",
  "PAYMENT_DELIVERED",
  "DELIVERED",
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export function isTrackingStatus(value: unknown): value is TrackingStatus {
  return typeof value === "string" && (TRACKING_STATUSES as readonly string[]).includes(value);
}

export interface OrderStatusHistoryRow {
  id: number;
  order_id: number;
  status: string;
  updated_by: number | null;
  timestamp: Date;
}

export interface OrderStatusHistoryEntry {
  id: number;
  status: string;
  updated_by: number | null;
  updated_by_name: string | null;
  timestamp: string;
}

export interface OrderTrackingResponse {
  order_id: number;
  tracking_status: TrackingStatus;
  pickup_ready_at: string | null;
  legacy_status: string;
  history: OrderStatusHistoryEntry[];
}
