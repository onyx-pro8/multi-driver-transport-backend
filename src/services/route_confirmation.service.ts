import { pool } from "../database";
import { isTrackingStatus } from "../models/orderTracking.model";
import type {
  RouteConfirmationStatusResponse,
  RouteSelectionResponse,
  RouteSelectionStatus,
  SegmentConfirmationDetail,
  SegmentConfirmationStatus,
  TransporterConfirmationItem,
} from "../models/routeConfirmation.model";
import { isSegmentLegStatus } from "../models/routeConfirmation.model";
import { addStatusHistory } from "./order_status.service";
import { createUserNotification, notifyOrderParticipants } from "./notification.service";
import { getOrderById, type OrderContext } from "./order.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";
import { syncOrderTrackingFromSegments } from "./segment_tracking.service";
import { isOrderRouteLocked } from "./orderRouteLock.service";
import {
  RouteCostError,
  calculateRouteCost,
  getRouteCostSummary,
} from "./routeCost.service";

export class RouteConfirmationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function loadRouteForOrder(routeId: number, orderId: number) {
  const result = await pool.query(
    `SELECT r.*, o.sender_user_id, o.receiver_user_id
     FROM order_routes r
     JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1 AND r.order_id = $2`,
    [routeId, orderId]
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function assertSenderReceiverAccess(
  orderId: number,
  ctx: OrderContext
): Promise<{ senderId: number; receiverId: number }> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteConfirmationError("Order not found", 404);
  if (ctx.role !== "admin" && ctx.userId !== order.sender_user_id && ctx.userId !== order.receiver_user_id) {
    throw new RouteConfirmationError("Forbidden", 403);
  }
  return { senderId: order.sender_user_id, receiverId: order.receiver_user_id };
}

function computeSelectionStatus(
  confirmations: { status: SegmentConfirmationStatus }[]
): RouteSelectionStatus {
  if (confirmations.length === 0) return "pending";
  const rejected = confirmations.filter((c) => c.status === "rejected").length;
  const accepted = confirmations.filter((c) => c.status === "accepted").length;
  const pending = confirmations.filter((c) => c.status === "pending").length;
  if (rejected > 0) return "rejected";
  if (accepted === confirmations.length) return "confirmed";
  if (accepted > 0 && pending > 0) return "partially_confirmed";
  return "pending";
}

export async function selectRoute(
  orderId: number,
  routeId: number,
  userId: number,
  ctx: OrderContext
): Promise<RouteSelectionResponse> {
  await assertSenderReceiverAccess(orderId, ctx);

  if (await isOrderRouteLocked(orderId)) {
    throw new RouteConfirmationError(
      "Cannot change route after confirmation or while delivery is in progress",
      409
    );
  }

  const route = await loadRouteForOrder(routeId, orderId);
  if (!route) throw new RouteConfirmationError("Route not found for this order", 404);

  // Ensure segment costs exist before confirmation flow.
  await calculateRouteCost(routeId, ctx);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO route_selections (order_id, selected_route_id, selected_by_user_id, status, payment_status)
       VALUES ($1, $2, $3, 'pending', 'pending')
       ON CONFLICT (order_id) DO UPDATE
         SET selected_route_id = EXCLUDED.selected_route_id,
             selected_by_user_id = EXCLUDED.selected_by_user_id,
             status = 'pending',
             payment_status = 'pending',
             updated_at = NOW()`,
      [orderId, routeId, userId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await sendConfirmationToTransporters(routeId, ctx);

  const selection = await getSelectedRoute(orderId, ctx);
  if (!selection) throw new RouteConfirmationError("Failed to load route selection", 500);
  return selection;
}

export async function sendConfirmationToTransporters(
  routeId: number,
  ctx: OrderContext
): Promise<void> {
  const routeResult = await pool.query(
    `SELECT r.*, o.sender_user_id, o.receiver_user_id
     FROM order_routes r
     JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1`,
    [routeId]
  );
  if (routeResult.rowCount === 0) throw new RouteConfirmationError("Route not found", 404);
  const route = routeResult.rows[0];
  const orderId = Number(route.order_id);

  if (ctx.role !== "admin" && ctx.userId !== Number(route.sender_user_id) && ctx.userId !== Number(route.receiver_user_id)) {
    throw new RouteConfirmationError("Forbidden", 403);
  }

  const segResult = await pool.query(
    `SELECT id, transporter_id FROM route_segment_costs WHERE route_id = $1 ORDER BY segment_index`,
    [routeId]
  );
  if (segResult.rowCount === 0) {
    await calculateRouteCost(routeId, ctx);
  }

  const segments = (
    await pool.query(
      `SELECT id, transporter_id FROM route_segment_costs WHERE route_id = $1 ORDER BY segment_index`,
      [routeId]
    )
  ).rows;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const seg of segments) {
      const segmentId = Number(seg.id);
      const transporterId = Number(seg.transporter_id);

      await client.query(
        `INSERT INTO segment_confirmations (route_id, segment_id, transporter_id, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (segment_id) DO UPDATE
           SET status = 'pending', rejection_reason = NULL, confirmed_at = NULL`,
        [routeId, segmentId, transporterId]
      );

      await client.query(
        `INSERT INTO route_confirmation_requests (route_id, transporter_id, segment_id, status, sent_at)
         VALUES ($1, $2, $3, 'sent', NOW())
         ON CONFLICT (segment_id) DO UPDATE
           SET status = 'sent', sent_at = NOW(), responded_at = NULL`,
        [routeId, transporterId, segmentId]
      );
    }

    await client.query(
      `UPDATE route_selections
       SET status = 'pending', updated_at = NOW()
       WHERE order_id = $1 AND selected_route_id = $2`,
      [orderId, routeId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  for (const seg of segments) {
    const transporterId = Number(seg.transporter_id);
    void createUserNotification({
      user_id: transporterId,
      order_id: orderId,
      type: "confirmation_request",
      title: "Route confirmation requested",
      body: `You have a new segment confirmation request for shipment #${orderId}. Review and accept or reject in your workspace.`,
    }).catch((err) => console.error("[notifications] confirmation_request failed:", err));
  }
}

async function assertSegmentTransporter(segmentId: number, transporterId: number) {
  const result = await pool.query(
    `SELECT sc.*, r.order_id
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE sc.id = $1`,
    [segmentId]
  );
  if (result.rowCount === 0) throw new RouteConfirmationError("Segment not found", 404);
  const row = result.rows[0];
  if (Number(row.transporter_id) !== transporterId) {
    throw new RouteConfirmationError("You are not assigned to this segment", 403);
  }
  return row;
}

export async function confirmSegment(
  segmentId: number,
  transporterId: number,
  ctx: OrderContext
): Promise<RouteConfirmationStatusResponse> {
  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new RouteConfirmationError("Only transporters can confirm segments", 403);
  }
  const effectiveTransporterId = ctx.role === "admin" ? transporterId : ctx.userId;
  const seg = await assertSegmentTransporter(segmentId, effectiveTransporterId);
  const routeId = Number(seg.route_id);

  await pool.query(
    `UPDATE segment_confirmations
     SET status = 'accepted', confirmed_at = NOW(), rejection_reason = NULL
     WHERE segment_id = $1`,
    [segmentId]
  );
  await pool.query(
    `UPDATE route_confirmation_requests
     SET status = 'accepted', responded_at = NOW()
     WHERE segment_id = $1`,
    [segmentId]
  );

  await finalizeRouteIfAllConfirmed(routeId);
  return getRouteConfirmationStatus(routeId, ctx);
}

export async function rejectSegment(
  segmentId: number,
  transporterId: number,
  reason: string,
  ctx: OrderContext
): Promise<RouteConfirmationStatusResponse> {
  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new RouteConfirmationError("Only transporters can reject segments", 403);
  }
  const effectiveTransporterId = ctx.role === "admin" ? transporterId : ctx.userId;
  const seg = await assertSegmentTransporter(segmentId, effectiveTransporterId);
  const routeId = Number(seg.route_id);

  await pool.query(
    `UPDATE segment_confirmations
     SET status = 'rejected', rejection_reason = $2, confirmed_at = NOW()
     WHERE segment_id = $1`,
    [segmentId, reason || null]
  );
  await pool.query(
    `UPDATE route_confirmation_requests
     SET status = 'rejected', responded_at = NOW()
     WHERE segment_id = $1`,
    [segmentId]
  );

  await pool.query(
    `UPDATE route_selections rs
     SET status = 'rejected', payment_status = 'not_required', updated_at = NOW()
     FROM order_routes r
     WHERE r.id = $1 AND rs.selected_route_id = r.id AND rs.order_id = r.order_id`,
    [routeId]
  );

  const orderId = Number(seg.order_id);
  const reasonText = reason?.trim() ? ` Reason: ${reason.trim()}` : "";
  void notifyOrderParticipants({
    order_id: orderId,
    type: "segment_rejected",
    title: "Segment rejected",
    body: `A transporter rejected a segment on shipment #${orderId}.${reasonText}`,
    exclude_user_id: ctx.userId,
  }).catch((err) => console.error("[notifications] segment_rejected failed:", err));

  return getRouteConfirmationStatus(routeId, ctx);
}

export async function getRouteConfirmationStatus(
  routeId: number,
  ctx: OrderContext
): Promise<RouteConfirmationStatusResponse> {
  const summary = await getRouteCostSummary(routeId, ctx);

  const confResult = await pool.query(
    `SELECT sc.*, u.full_name AS transporter_name
     FROM segment_confirmations sc
     JOIN users u ON u.id = sc.transporter_id
     WHERE sc.route_id = $1`,
    [routeId]
  );
  const confBySegment = new Map(
    confResult.rows.map((r) => [Number(r.segment_id), r])
  );

  const segments: SegmentConfirmationDetail[] = summary.segments.map((seg) => {
    const conf = confBySegment.get(seg.segment_id);
    const status = (conf?.status ?? "pending") as SegmentConfirmationStatus;
    return {
      segment_id: seg.segment_id,
      segment_index: seg.segment_index,
      transporter_id: seg.transporter_id,
      transporter_name: seg.transporter_name,
      from_node_id: seg.from_node_id,
      from_label: seg.from_label,
      to_node_id: seg.to_node_id,
      to_label: seg.to_label,
      leg_phase: seg.leg_phase ?? null,
      handoff_role: seg.handoff_role ?? null,
      status,
      leg_status: isSegmentLegStatus(conf?.leg_status) ? conf.leg_status : "not_started",
      rejection_reason: conf?.rejection_reason != null ? String(conf.rejection_reason) : null,
      confirmed_at: conf?.confirmed_at ? new Date(conf.confirmed_at).toISOString() : null,
      final_cost: seg.final_cost,
      currency: seg.currency,
    };
  });

  const confirmed_count = segments.filter((s) => s.status === "accepted").length;
  const pending_count = segments.filter((s) => s.status === "pending").length;
  const rejected_count = segments.filter((s) => s.status === "rejected").length;
  const total_segments = segments.length;

  const selResult = await pool.query(
    `SELECT status, payment_status FROM route_selections WHERE selected_route_id = $1`,
    [routeId]
  );
  const selection_status = (
    selResult.rowCount ? String(selResult.rows[0].status) : computeSelectionStatus(segments)
  ) as RouteSelectionStatus;
  const payment_status = selResult.rowCount
    ? (String(selResult.rows[0].payment_status) as "pending" | "ready" | "not_required")
    : "pending";

  return {
    route_id: routeId,
    order_id: summary.order_id,
    route_label: summary.route_label,
    selection_status,
    payment_status,
    confirmed_count,
    pending_count,
    rejected_count,
    total_segments,
    progress_percent:
      total_segments > 0 ? Math.round((confirmed_count / total_segments) * 100) : 0,
    segments,
  };
}

export async function finalizeRouteIfAllConfirmed(routeId: number): Promise<void> {
  const confResult = await pool.query(
    `SELECT status FROM segment_confirmations WHERE route_id = $1`,
    [routeId]
  );
  if (confResult.rowCount === 0) return;

  const statuses = confResult.rows.map((r) => String(r.status) as SegmentConfirmationStatus);
  const selectionStatus = computeSelectionStatus(
    statuses.map((status) => ({ status }))
  );

  const paymentStatus =
    selectionStatus === "confirmed" ? "ready" : selectionStatus === "rejected" ? "not_required" : "pending";

  await pool.query(
    `UPDATE route_selections rs
     SET status = $2, payment_status = $3, updated_at = NOW()
     FROM order_routes r
     WHERE r.id = $1 AND rs.selected_route_id = r.id AND rs.order_id = r.order_id`,
    [routeId, selectionStatus, paymentStatus]
  );

  if (selectionStatus === "confirmed") {
    await pool.query(
      `UPDATE orders o
       SET tracking_status = 'CONFIRMED', updated_at = NOW()
       FROM order_routes r
       WHERE r.id = $1 AND o.id = r.order_id`,
      [routeId]
    );
    const orderResult = await pool.query(
      `SELECT order_id FROM order_routes WHERE id = $1`,
      [routeId]
    );
    if (orderResult.rowCount) {
      const orderId = Number(orderResult.rows[0].order_id);
      await addStatusHistory(orderId, "CONFIRMED", null);
      void notifyOrderParticipants({
        order_id: orderId,
        type: "route_confirmed",
        title: "Route fully confirmed",
        body: `All transporters confirmed their segments for shipment #${orderId}. Pickup can be scheduled when ready.`,
      }).catch((err) => console.error("[notifications] route_confirmed failed:", err));
    }
  }
}

export async function getSelectedRoute(
  orderId: number,
  ctx: OrderContext
): Promise<RouteSelectionResponse | null> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteConfirmationError("Order not found", 404);

  const result = await pool.query(
    `SELECT rs.*, r.route_label
     FROM route_selections rs
     JOIN order_routes r ON r.id = rs.selected_route_id
     WHERE rs.order_id = $1`,
    [orderId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    id: Number(row.id),
    order_id: Number(row.order_id),
    selected_route_id: Number(row.selected_route_id),
    selected_by_user_id: Number(row.selected_by_user_id),
    status: String(row.status) as RouteSelectionStatus,
    payment_status: String(row.payment_status) as "pending" | "ready" | "not_required",
    route_label: String(row.route_label),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listTransporterConfirmations(
  ctx: OrderContext
): Promise<TransporterConfirmationItem[]> {
  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new RouteConfirmationError("Forbidden", 403);
  }
  const transporterId = ctx.userId;

  const initialResult = await pool.query(
    `SELECT DISTINCT o.id AS order_id, o.payment_method, o.pickup_ready_at, o.tracking_status
     FROM segment_confirmations sc
     JOIN order_routes r ON r.id = sc.route_id
     JOIN orders o ON o.id = r.order_id
     WHERE sc.transporter_id = $1`,
    [transporterId]
  );
  const syncTargets = initialResult.rows.filter(
    (row) =>
      isPffPaymentMethod(String(row.payment_method ?? "")) &&
      row.pickup_ready_at &&
      !["DELIVERED", "REJECTED", "AWAITING_CONNECT"].includes(String(row.tracking_status ?? ""))
  );
  if (syncTargets.length > 0) {
    await Promise.all(
      syncTargets.map((row) => syncOrderTrackingFromSegments(Number(row.order_id)))
    );
  }

  const result = await pool.query(
    `SELECT sc.id AS confirmation_id,
            sc.route_id,
            sc.segment_id,
            sc.status,
            sc.leg_status,
            sc.rejection_reason,
            r.order_id,
            r.route_label,
            rsc.segment_index,
            rsc.leg_phase,
            rsc.handoff_role,
            rsc.from_node_id,
            rsc.to_node_id,
            o.sender_address,
            o.destination_address,
            o.tracking_status AS order_tracking_status,
            o.pickup_ready_at,
            o.goods_ready_at,
            o.payment_method,
            rs.status AS route_selection_status,
            (
              SELECT COUNT(*)::int
              FROM route_segment_costs rsc2
              WHERE rsc2.route_id = r.id
            ) AS route_segment_count,
            (
              SELECT sc_prev.leg_status
              FROM route_segment_costs rsc_prev
              JOIN segment_confirmations sc_prev ON sc_prev.segment_id = rsc_prev.id
              WHERE rsc_prev.route_id = r.id
                AND rsc_prev.segment_index = rsc.segment_index - 1
                AND (
                  rsc.leg_phase IS NULL
                  OR rsc_prev.leg_phase IS NOT DISTINCT FROM rsc.leg_phase
                )
              LIMIT 1
            ) AS previous_leg_status,
            rcr.sent_at
     FROM segment_confirmations sc
     JOIN order_routes r ON r.id = sc.route_id
     JOIN route_segment_costs rsc ON rsc.id = sc.segment_id
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN route_selections rs ON rs.order_id = r.order_id AND rs.selected_route_id = r.id
     LEFT JOIN route_confirmation_requests rcr ON rcr.segment_id = sc.segment_id
     WHERE sc.transporter_id = $1
     ORDER BY sc.created_at DESC`,
    [transporterId]
  );

  const summaryCache = new Map<number, Awaited<ReturnType<typeof getRouteCostSummary>>>();

  const items: TransporterConfirmationItem[] = [];
  for (const row of result.rows) {
    const routeId = Number(row.route_id);
    if (!summaryCache.has(routeId)) {
      try {
        summaryCache.set(routeId, await getRouteCostSummary(routeId, ctx));
      } catch (err) {
        if (err instanceof RouteCostError) continue;
        throw err;
      }
    }
    const summary = summaryCache.get(routeId)!;
    const seg = summary.segments.find((s) => s.segment_id === Number(row.segment_id));

    items.push({
      confirmation_id: Number(row.confirmation_id),
      route_id: routeId,
      order_id: Number(row.order_id),
      segment_id: Number(row.segment_id),
      segment_index: Number(row.segment_index),
      leg_phase:
        row.leg_phase === "payment" || row.leg_phase === "goods"
          ? row.leg_phase
          : null,
      handoff_role:
        row.handoff_role === "payment_delivery" || row.handoff_role === "goods_pickup"
          ? row.handoff_role
          : seg?.handoff_role ?? null,
      from_label: seg?.from_label ?? String(row.from_node_id),
      to_label: seg?.to_label ?? String(row.to_node_id),
      status: String(row.status) as SegmentConfirmationStatus,
      leg_status: isSegmentLegStatus(row.leg_status) ? row.leg_status : "not_started",
      rejection_reason: row.rejection_reason != null ? String(row.rejection_reason) : null,
      route_label: String(row.route_label),
      sender_address: String(row.sender_address),
      destination_address: String(row.destination_address),
      sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : new Date().toISOString(),
      route_selection_status:
        row.route_selection_status != null
          ? (String(row.route_selection_status) as RouteSelectionStatus)
          : null,
      order_tracking_status: isTrackingStatus(row.order_tracking_status)
        ? row.order_tracking_status
        : "PICKUP_AVAILABLE",
      pickup_ready_at: row.pickup_ready_at
        ? new Date(String(row.pickup_ready_at)).toISOString()
        : null,
      goods_ready_at: row.goods_ready_at
        ? new Date(String(row.goods_ready_at)).toISOString()
        : null,
      payment_method: String(row.payment_method ?? ""),
      route_segment_count: Number(row.route_segment_count ?? 0),
      previous_leg_status: isSegmentLegStatus(row.previous_leg_status)
        ? row.previous_leg_status
        : row.previous_leg_status == null
          ? null
          : "not_started",
      final_cost: seg?.final_cost ?? null,
      currency: seg?.currency ?? "CAD",
      cost_status: seg?.cost_status ?? "missing",
    });
  }

  return items;
}
