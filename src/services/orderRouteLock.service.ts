import { pool } from "../database";
import { isTrackingStatus, type TrackingStatus } from "../models/orderTracking.model";
import { isPffPaymentMethod } from "../utils/paymentFlow";

export type OrderRouteLockReason =
  | "confirmed_route"
  | "confirmation_pending"
  | "delivery_in_progress";

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

/** True while transporters still have open or accepted segment confirmations. */
async function getActiveConfirmationLock(
  orderId: number,
): Promise<{ locked: boolean; routeId: number | null }> {
  const orderResult = await pool.query(
    `SELECT payment_method FROM orders WHERE id = $1`,
    [orderId],
  );
  if ((orderResult.rowCount ?? 0) > 0) {
    const isPff = isPffPaymentMethod(String(orderResult.rows[0].payment_method ?? ""));
    if (isPff) {
      const selections = await pool.query(
        `SELECT route_purpose, selected_route_id FROM route_selections
         WHERE order_id = $1 AND route_purpose IN ('payment', 'goods')`,
        [orderId],
      );
      const byPurpose = new Map(
        selections.rows.map((r) => [String(r.route_purpose), r]),
      );
      const payment = byPurpose.get("payment");
      const goods = byPurpose.get("goods");
      const bothSelected =
        payment?.selected_route_id != null && goods?.selected_route_id != null;
      if (!bothSelected) {
        return { locked: false, routeId: null };
      }
    }
  }

  const result = await pool.query(
    `SELECT DISTINCT r.id AS route_id
     FROM segment_confirmations sc
     JOIN order_routes r ON r.id = sc.route_id
     JOIN route_selections rs ON rs.selected_route_id = r.id AND rs.order_id = r.order_id
     WHERE r.order_id = $1
       AND sc.status IN ('pending', 'accepted')
       AND rs.status <> 'rejected'`,
    [orderId],
  );
  if (result.rowCount === 0) return { locked: false, routeId: null };
  return { locked: true, routeId: Number(result.rows[0].route_id) };
}

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
  const confirmationLock = await getActiveConfirmationLock(orderId);

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

    const bothSelected =
      payment?.selected_route_id != null && goods?.selected_route_id != null;

    if (confirmationLock.locked && bothSelected) {
      return {
        locked: true,
        selectedRouteId: confirmationLock.routeId,
        reason: "confirmation_pending",
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

  if (selectionStatus === "rejected") {
    return { locked: false, selectedRouteId: null, reason: null };
  }

  if (confirmationLock.locked) {
    return {
      locked: true,
      selectedRouteId: selectedRouteId ?? confirmationLock.routeId,
      reason: "confirmation_pending",
    };
  }

  if (IN_PROGRESS_TRACKING.includes(tracking) && (pickupReady || tracking !== "PICKUP_AVAILABLE")) {
    return { locked: true, selectedRouteId, reason: "delivery_in_progress" };
  }

  return { locked: false, selectedRouteId, reason: null };
}

export async function isOrderRouteLocked(orderId: number): Promise<boolean> {
  return (await getOrderRouteLockInfo(orderId)).locked;
}
