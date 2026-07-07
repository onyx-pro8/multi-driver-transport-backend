import { pool } from "../database";
import { isTrackingStatus, type TrackingStatus } from "../models/orderTracking.model";
import { isPffPaymentMethod } from "../utils/paymentFlow";

export type OrderRouteLockReason = "confirmed_route" | "delivery_in_progress";

export interface OrderRouteLockInfo {
  locked: boolean;
  selectedRouteId: number | null;
  reason: OrderRouteLockReason | null;
}

const IN_PROGRESS_TRACKING: TrackingStatus[] = [
  "PICKUP_AVAILABLE",
  "PICKED_UP",
  "IN_TRANSIT",
  "DELIVERED",
];

/**
 * Orders with a confirmed route or active delivery keep their persisted routes
 * and statuses even when zones/schedules change and no live path exists anymore.
 */
export async function getOrderRouteLockInfo(orderId: number): Promise<OrderRouteLockInfo> {
  const result = await pool.query(
    `SELECT o.tracking_status, o.pickup_ready_at, o.payment_method,
            rs.status AS selection_status, rs.selected_route_id, rs.route_purpose
     FROM orders o
     LEFT JOIN route_selections rs ON rs.order_id = o.id
     WHERE o.id = $1`,
    [orderId],
  );
  if (result.rowCount === 0) {
    return { locked: false, selectedRouteId: null, reason: null };
  }

  const row = result.rows[0];
  const tracking: TrackingStatus = isTrackingStatus(row.tracking_status)
    ? row.tracking_status
    : "CONFIRMED";
  const pickupReady = row.pickup_ready_at != null;
  const isPff = isPffPaymentMethod(String(row.payment_method ?? ""));

  if (isPff) {
    const selections = await pool.query(
      `SELECT selected_route_id, status, route_purpose FROM route_selections
       WHERE order_id = $1 AND route_purpose IN ('payment', 'goods')`,
      [orderId],
    );
    const byPurpose = new Map(
      selections.rows.map((r) => [String(r.route_purpose), r]),
    );
    const payment = byPurpose.get("payment");
    const goods = byPurpose.get("goods");
    const bothConfirmed =
      payment && goods &&
      String(payment.status) === "confirmed" &&
      String(goods.status) === "confirmed";

    if (bothConfirmed) {
      return {
        locked: true,
        selectedRouteId: payment ? Number(payment.selected_route_id) : null,
        reason: "confirmed_route",
      };
    }

    const anyRejected =
      (payment && String(payment.status) === "rejected") ||
      (goods && String(goods.status) === "rejected");
    if (anyRejected) {
      return { locked: false, selectedRouteId: null, reason: null };
    }

    if (
      IN_PROGRESS_TRACKING.includes(tracking) &&
      (pickupReady || tracking !== "PICKUP_AVAILABLE")
    ) {
      return {
        locked: true,
        selectedRouteId: payment ? Number(payment.selected_route_id) : null,
        reason: "delivery_in_progress",
      };
    }

    return { locked: false, selectedRouteId: null, reason: null };
  }

  const selectedRouteId =
    row.selected_route_id != null ? Number(row.selected_route_id) : null;
  const selectionStatus =
    row.selection_status != null ? String(row.selection_status) : null;

  if (selectionStatus === "confirmed") {
    return { locked: true, selectedRouteId, reason: "confirmed_route" };
  }

  if (IN_PROGRESS_TRACKING.includes(tracking) && (pickupReady || tracking !== "PICKUP_AVAILABLE")) {
    return { locked: true, selectedRouteId, reason: "delivery_in_progress" };
  }

  return { locked: false, selectedRouteId, reason: null };
}

export async function isOrderRouteLocked(orderId: number): Promise<boolean> {
  return (await getOrderRouteLockInfo(orderId)).locked;
}
