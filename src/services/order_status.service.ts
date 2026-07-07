import { pool } from "../database";
import {
  isTrackingStatus,
  type OrderStatusHistoryEntry,
  type OrderTrackingResponse,
  type TrackingStatus,
  TRACKING_STATUSES,
} from "../models/orderTracking.model";
import { getOrderById, syncLegacyOrderStatus, type OrderContext } from "./order.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";
import { notifyOrderParticipants, createUserNotification } from "./notification.service";
import { syncOrderTrackingFromSegments } from "./segment_tracking.service";

export class OrderStatusError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const TRANSITIONS: Record<TrackingStatus, TrackingStatus[]> = {
  AWAITING_CONNECT: [],
  REJECTED: [],
  CONFIRMED: ["PICKUP_AVAILABLE", "ROUTES_IN_PROGRESS"],
  ROUTES_IN_PROGRESS: [],
  ROUTES_READY: ["PICKUP_AVAILABLE"],
  PICKUP_AVAILABLE: ["PICKED_UP"],
  PICKED_UP: ["IN_TRANSIT"],
  IN_TRANSIT: ["DELIVERED", "PAYMENT_DELIVERED"],
  PAYMENT_DELIVERED: ["PICKUP_AVAILABLE"],
  DELIVERED: [],
};

export function validateStatusTransition(
  oldStatus: TrackingStatus,
  newStatus: TrackingStatus
): boolean {
  if (oldStatus === newStatus) return true;
  return TRANSITIONS[oldStatus]?.includes(newStatus) ?? false;
}

export async function addStatusHistory(
  orderId: number,
  status: string,
  updatedBy: number | null
): Promise<void> {
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, updated_by) VALUES ($1, $2, $3)`,
    [orderId, status, updatedBy]
  );
}

async function assertRouteConfirmed(orderId: number): Promise<void> {
  const orderResult = await pool.query(
    `SELECT payment_method, tracking_status FROM orders WHERE id = $1`,
    [orderId],
  );
  const paymentMethod = String(orderResult.rows[0]?.payment_method ?? "");
  const tracking = String(orderResult.rows[0]?.tracking_status ?? "");

  if (isPffPaymentMethod(paymentMethod)) {
    if (
      tracking === "ROUTES_READY" ||
      tracking === "PICKUP_AVAILABLE" ||
      tracking === "PAYMENT_DELIVERED" ||
      tracking === "PICKED_UP" ||
      tracking === "IN_TRANSIT" ||
      tracking === "DELIVERED"
    ) {
      return;
    }
    const result = await pool.query(
      `SELECT route_purpose, status FROM route_selections
       WHERE order_id = $1 AND route_purpose IN ('payment', 'goods')`,
      [orderId],
    );
    const byPurpose = new Map(result.rows.map((r) => [String(r.route_purpose), String(r.status)]));
    if (byPurpose.get("payment") === "confirmed" && byPurpose.get("goods") === "confirmed") {
      return;
    }
    throw new OrderStatusError(
      "Both payment and goods routes must be confirmed before updating tracking status",
      400,
    );
  }

  const result = await pool.query(
    `SELECT status FROM route_selections WHERE order_id = $1 AND route_purpose = 'standard'`,
    [orderId],
  );
  if (result.rowCount === 0 || String(result.rows[0].status) !== "confirmed") {
    throw new OrderStatusError("Route must be confirmed before updating tracking status", 400);
  }
}

async function loadPickupReadyAt(orderId: number): Promise<Date | null> {
  const result = await pool.query(
    `SELECT pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  const raw = result.rows[0]?.pickup_ready_at;
  return raw ? new Date(String(raw)) : null;
}

async function getDriverSegmentContext(
  orderId: number,
  userId: number
): Promise<{ segment_index: number; segment_count: number } | null> {
  const result = await pool.query(
    `SELECT rsc.segment_index, rsc.route_id,
            (
              SELECT COUNT(*)::int
              FROM route_segment_costs rsc2
              WHERE rsc2.route_id = rsc.route_id
            ) AS segment_count
     FROM route_segment_costs rsc
     JOIN route_selections rs
       ON rs.selected_route_id = rsc.route_id
      AND rs.order_id = $1
      AND rs.status = 'confirmed'
     WHERE rsc.transporter_id = $2
     ORDER BY rsc.segment_index
     LIMIT 1`,
    [orderId, userId]
  );
  if (result.rowCount === 0) return null;
  return {
    segment_index: Number(result.rows[0].segment_index),
    segment_count: Number(result.rows[0].segment_count ?? 0),
  };
}

function inTransitSegmentIndex(segmentCount: number): number {
  return segmentCount <= 1 ? 0 : 1;
}

export async function getOrderStatus(
  orderId: number,
  ctx: OrderContext
): Promise<OrderTrackingResponse> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderStatusError("Order not found", 404);

  await syncOrderTrackingFromSegments(orderId);

  const histResult = await pool.query(
    `SELECT h.*, u.full_name AS updated_by_name
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.updated_by
     WHERE h.order_id = $1
     ORDER BY h.timestamp ASC`,
    [orderId]
  );

  const history: OrderStatusHistoryEntry[] = histResult.rows.map((row) => ({
    id: Number(row.id),
    status: String(row.status),
    updated_by: row.updated_by != null ? Number(row.updated_by) : null,
    updated_by_name: row.updated_by_name != null ? String(row.updated_by_name) : null,
    timestamp: new Date(row.timestamp).toISOString(),
  }));

  const trackingResult = await pool.query(
    `SELECT tracking_status, pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  const raw = trackingResult.rows[0]?.tracking_status;
  const tracking_status: TrackingStatus = isTrackingStatus(raw) ? raw : "CONFIRMED";
  const pickupReadyRaw = trackingResult.rows[0]?.pickup_ready_at;

  return {
    order_id: orderId,
    tracking_status,
    pickup_ready_at: pickupReadyRaw ? new Date(String(pickupReadyRaw)).toISOString() : null,
    legacy_status: order.status,
    history,
  };
}

export async function updateOrderStatus(
  orderId: number,
  status: TrackingStatus,
  ctx: OrderContext
): Promise<OrderTrackingResponse> {
  if (!isTrackingStatus(status)) {
    throw new OrderStatusError(`Invalid tracking status. Allowed: ${TRACKING_STATUSES.join(", ")}`);
  }

  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderStatusError("Order not found", 404);

  await assertRouteConfirmed(orderId);

  if (status !== "DELIVERED") {
    const awaiting = await pool.query(
      `SELECT tracking_status FROM orders WHERE id = $1`,
      [orderId]
    );
    const ts = awaiting.rows[0]?.tracking_status;
    if (ts === "AWAITING_CONNECT") {
      throw new OrderStatusError("Sender must connect this order before updating delivery status", 400);
    }
  }

  const currentResult = await pool.query(
    `SELECT tracking_status, pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  const currentRaw = currentResult.rows[0]?.tracking_status;
  const current: TrackingStatus = isTrackingStatus(currentRaw) ? currentRaw : "CONFIRMED";
  const pickupReadyAt = currentResult.rows[0]?.pickup_ready_at
    ? new Date(String(currentResult.rows[0].pickup_ready_at))
    : null;

  if (status === "PICKUP_AVAILABLE") {
    const isPff = isPffPaymentMethod(order.payment_method);
    if (isPff) {
      const goodsReadyResult = await pool.query(
        `SELECT goods_ready_at FROM orders WHERE id = $1`,
        [orderId]
      );
      const goodsReadyAt = goodsReadyResult.rows[0]?.goods_ready_at
        ? new Date(String(goodsReadyResult.rows[0].goods_ready_at))
        : null;

      if (current === "PAYMENT_DELIVERED" || goodsReadyAt) {
        if (ctx.role !== "sender" && ctx.role !== "admin") {
          throw new OrderStatusError(
            "Only the sender can mark goods ready after payment is delivered",
            403
          );
        }
        if (ctx.role === "sender" && order.sender_user_id !== ctx.userId) {
          throw new OrderStatusError("Forbidden", 403);
        }
        if (goodsReadyAt) {
          return getOrderStatus(orderId, ctx);
        }
        if (current !== "PAYMENT_DELIVERED") {
          throw new OrderStatusError(
            "Payment must be delivered to the producer before goods can be marked ready",
            400
          );
        }
        await pool.query(
          `UPDATE orders
           SET tracking_status = 'PICKUP_AVAILABLE', goods_ready_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [orderId]
        );
        await addStatusHistory(orderId, "GOODS_READY", ctx.userId);
        await syncLegacyOrderStatus(orderId, "PICKUP_AVAILABLE");

        void notifyOrderParticipants({
          order_id: orderId,
          type: "goods_ready",
          title: "Goods ready for pickup",
          body: `Shipment #${orderId}: producer marked goods ready. Transporters can collect the order for delivery to the receiver.`,
          exclude_user_id: ctx.userId,
        }).catch((err) => console.error("[notifications] goods_ready failed:", err));

        return getOrderStatus(orderId, ctx);
      }

      if (ctx.role !== "receiver" && ctx.role !== "admin") {
        throw new OrderStatusError(
          "Only the receiver can mark pickup available for PFF (Advanced Payment) orders",
          403
        );
      }
      if (ctx.role === "receiver" && order.receiver_user_id !== ctx.userId) {
        throw new OrderStatusError("Forbidden", 403);
      }
    } else if (ctx.role !== "sender" && ctx.role !== "admin") {
      throw new OrderStatusError("Only the sender can mark pickup as ready", 403);
    }
    if (pickupReadyAt) {
      return getOrderStatus(orderId, ctx);
    }
    if (current !== "CONFIRMED" && current !== "ROUTES_READY" && current !== "PICKUP_AVAILABLE") {
      throw new OrderStatusError("Cannot mark pickup ready from the current status", 400);
    }
    await pool.query(
      `UPDATE orders
       SET tracking_status = 'PICKUP_AVAILABLE', pickup_ready_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );
    await addStatusHistory(orderId, "PICKUP_AVAILABLE", ctx.userId);
    await syncLegacyOrderStatus(orderId, "PICKUP_AVAILABLE");

    void notifyOrderParticipants({
      order_id: orderId,
      type: "pickup_ready",
      title: isPff ? "PFF payment pickup available" : "Pickup ready",
      body: isPff
        ? `Shipment #${orderId}: receiver marked payment pickup available. Transporters may collect the payment package (cheque/cash) from the receiver. Producer — prepare goods after payment arrives.`
        : `Shipment #${orderId} is ready for pickup. Transporters on the route can begin collection.`,
      exclude_user_id: ctx.userId,
    }).catch((err) => console.error("[notifications] pickup_ready failed:", err));

    return getOrderStatus(orderId, ctx);
  }

  const isPff = isPffPaymentMethod(order.payment_method);
  if (!pickupReadyAt && !(isPff && status === "DELIVERED")) {
    throw new OrderStatusError("Sender must mark pickup as ready first", 400);
  }

  if (!validateStatusTransition(current, status)) {
    throw new OrderStatusError(
      `Cannot transition from ${current} to ${status}. Valid next: ${TRANSITIONS[current].join(", ") || "none"}`
    );
  }

  if (status === "PICKED_UP" || status === "IN_TRANSIT") {
    if (ctx.role === "driver") {
      throw new OrderStatusError(
        "Use segment-level status updates on the confirmations page for each leg",
        400
      );
    }
    if (ctx.role !== "admin") {
      throw new OrderStatusError("Forbidden", 403);
    }
  } else if (status === "DELIVERED") {
    if (ctx.role !== "receiver" && ctx.role !== "admin") {
      throw new OrderStatusError("Only the receiver can mark the order as delivered", 403);
    }
    if (ctx.role === "receiver" && order.receiver_user_id !== ctx.userId) {
      throw new OrderStatusError("Forbidden", 403);
    }
  }

  await pool.query(
    `UPDATE orders SET tracking_status = $2, updated_at = NOW() WHERE id = $1`,
    [orderId, status]
  );
  await addStatusHistory(orderId, status, ctx.userId);
  await syncLegacyOrderStatus(orderId, status);

  if (status === "DELIVERED") {
    void notifyOrderParticipants({
      order_id: orderId,
      type: "delivered",
      title: "Shipment delivered",
      body: `Shipment #${orderId} was marked as delivered.`,
      exclude_user_id: ctx.userId,
    }).catch((err) => console.error("[notifications] delivered failed:", err));
  }

  return getOrderStatus(orderId, ctx);
}

export async function notifyPaymentPickedUpToSender(
  orderId: number,
  ctx: OrderContext
): Promise<OrderTrackingResponse> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderStatusError("Order not found", 404);
  if (!isPffPaymentMethod(order.payment_method)) {
    throw new OrderStatusError("Only PFF orders support payment pickup notification", 400);
  }
  if (ctx.role !== "receiver" && ctx.role !== "admin") {
    throw new OrderStatusError("Only the receiver can notify the producer about payment pickup", 403);
  }
  if (ctx.role === "receiver" && order.receiver_user_id !== ctx.userId) {
    throw new OrderStatusError("Forbidden", 403);
  }
  if (order.payment_pickup_notified_at) {
    return getOrderStatus(orderId, ctx);
  }
  if (!order.pickup_ready_at) {
    throw new OrderStatusError("Payment pickup must be marked available first", 400);
  }

  const pickupSeg = await pool.query(
    `SELECT sc.leg_status
     FROM route_segment_costs rsc
     JOIN segment_confirmations sc ON sc.segment_id = rsc.id
     JOIN route_selections rs ON rs.selected_route_id = rsc.route_id AND rs.order_id = $1
     WHERE rsc.leg_phase = 'payment' AND rsc.segment_index = (
       SELECT MIN(segment_index) FROM route_segment_costs r2
       WHERE r2.route_id = rsc.route_id AND r2.leg_phase = 'payment'
     )
     LIMIT 1`,
    [orderId]
  );
  const legStatus = pickupSeg.rows[0]?.leg_status;
  if (legStatus !== "picked_up" && legStatus !== "in_transit") {
    throw new OrderStatusError(
      "A transporter must mark the payment package as picked up before you can notify the producer",
      400
    );
  }

  await pool.query(
    `UPDATE orders SET payment_pickup_notified_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [orderId]
  );
  await addStatusHistory(orderId, "PAYMENT_PICKUP_NOTIFIED", ctx.userId);

  void createUserNotification({
    user_id: order.sender_user_id,
    order_id: orderId,
    type: "payment_pickup_notified",
    title: "Payment collected from receiver",
    body: `Shipment #${orderId}: the receiver confirms the payment package was collected. Prepare the ordered goods for the delivering transporter.`,
  }).catch((err) => console.error("[notifications] payment_pickup_notified failed:", err));

  return getOrderStatus(orderId, ctx);
}
