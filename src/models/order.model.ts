import type { OrderPackageEntry, PackageType } from "./package.model";
import type { PaymentPackageEntry } from "./paymentPackage.model";

export const ORDER_STATUSES = ["submitted", "delivering", "received"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export interface OrderRow {
  id: number;
  sender_user_id: number;
  receiver_user_id: number;
  driver_user_id: number | null;
  sender_address: string;
  sender_billing_address: string;
  sender_lat: number | null;
  sender_lng: number | null;
  destination_address: string;
  receiver_billing_address: string;
  destination_lat: number | null;
  destination_lng: number | null;
  receiver_phone: string;
  notes: string;
  pickup_h3: string | null;
  delivery_h3: string | null;
  h3_resolution: number | null;
  source_name: string;
  source_contact: string;
  payment_method: string;
  shipping_method: string;
  package_description: string;
  package_type: PackageType | null;
  packages: OrderPackageEntry[];
  package_factor: number | null;
  payment_packages: PaymentPackageEntry[];
  payment_pickup_notified_at: Date | null;
  weight_lbs: number | null;
  package_weight_unit: string;
  package_length: number | null;
  package_width: number | null;
  package_height: number | null;
  package_dimension_unit: string;
  dimensions: string;
  status: OrderStatus;
  tracking_status: import("./orderTracking.model").TrackingStatus;
  pickup_ready_at: Date | null;
  goods_ready_at: Date | null;
  route_schedule_at: Date | null;
  submitted_at: Date;
  delivering_at: Date | null;
  received_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderResponse {
  id: number;
  sender_user_id: number;
  receiver_user_id: number;
  driver_user_id: number | null;
  sender_name: string;
  sender_phone: string;
  receiver_name: string;
  receiver_phone: string;
  sender_address: string;
  sender_billing_address: string;
  sender_lat: number | null;
  sender_lng: number | null;
  destination_address: string;
  receiver_billing_address: string;
  destination_lat: number | null;
  destination_lng: number | null;
  notes: string;
  pickup_h3: string | null;
  delivery_h3: string | null;
  h3_resolution: number | null;
  source_name: string;
  source_contact: string;
  payment_method: string;
  shipping_method: string;
  package_description: string;
  package_type: PackageType | null;
  packages: OrderPackageEntry[];
  package_factor: number | null;
  payment_packages: PaymentPackageEntry[];
  payment_pickup_notified_at: string | null;
  weight_lbs: number | null;
  package_weight_unit: string;
  package_length: number | null;
  package_width: number | null;
  package_height: number | null;
  package_dimension_unit: string;
  dimensions: string;
  status: OrderStatus;
  tracking_status: import("./orderTracking.model").TrackingStatus;
  pickup_ready_at: string | null;
  goods_ready_at: string | null;
  route_schedule_at?: string | null;
  /** Milestone 6/7 — populated on list/detail when a route has been selected. */
  route_selection_status?: import("./routeConfirmation.model").RouteSelectionStatus | null;
  selected_route_id?: number | null;
  selected_route_label?: string | null;
  payment_route_selection_status?: import("./routeConfirmation.model").RouteSelectionStatus | null;
  goods_route_selection_status?: import("./routeConfirmation.model").RouteSelectionStatus | null;
  payment_selected_route_id?: number | null;
  goods_selected_route_id?: number | null;
  submitted_at: string;
  delivering_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
}
