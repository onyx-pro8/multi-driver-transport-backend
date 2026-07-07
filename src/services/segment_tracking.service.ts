import { pool } from "../database";
import {
  isSegmentLegStatus,
  type SegmentLegStatus,
  SEGMENT_LEG_STATUSES,
} from "../models/routeConfirmation.model";
import type { TrackingStatus } from "../models/orderTracking.model";
import { isTrackingStatus } from "../models/orderTracking.model";
import { addStatusHistory } from "./order_status.service";
import { notifyOrderParticipants } from "./notification.service";
import { syncLegacyOrderStatus, type OrderContext } from "./order.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";

export class SegmentTrackingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface SegmentRow {
  confirmation_id: number;
  route_id: number;
  segment_id: number;
  segment_index: number;
  transporter_id: number;
  confirmation_status: string;
  leg_status: SegmentLegStatus;
  leg_phase: string | null;
  handoff_role: string | null;
  order_id: number;
  payment_method: string;
  goods_ready_at: Date | null;
}

async function loadSegment(segmentId: number): Promise<SegmentRow | null> {
  const result = await pool.query(
    `SELECT sc.id AS confirmation_id,
            sc.route_id,
            sc.segment_id,
            sc.transporter_id,
            sc.status AS confirmation_status,
            sc.leg_status,
            rsc.segment_index,
            rsc.leg_phase,
            rsc.handoff_role,
            r.order_id,
            o.payment_method,
            o.goods_ready_at
     FROM segment_confirmations sc
     JOIN route_segment_costs rsc ON rsc.id = sc.segment_id
     JOIN order_routes r ON r.id = sc.route_id
     JOIN orders o ON o.id = r.order_id
     WHERE sc.segment_id = $1`,
    [segmentId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const legRaw = row.leg_status;
  return {
    confirmation_id: Number(row.confirmation_id),
    route_id: Number(row.route_id),
    segment_id: Number(row.segment_id),
    segment_index: Number(row.segment_index),
    transporter_id: Number(row.transporter_id),
    confirmation_status: String(row.confirmation_status),
    leg_status: isSegmentLegStatus(legRaw) ? legRaw : "not_started",
    leg_phase: row.leg_phase != null ? String(row.leg_phase) : null,
    handoff_role: row.handoff_role != null ? String(row.handoff_role) : null,
    order_id: Number(row.order_id),
    payment_method: String(row.payment_method ?? ""),
    goods_ready_at: row.goods_ready_at ? new Date(String(row.goods_ready_at)) : null,
  };
}

async function assertRouteConfirmedForOrder(orderId: number): Promise<void> {
  const orderResult = await pool.query(
    `SELECT payment_method, tracking_status FROM orders WHERE id = $1`,
    [orderId],
  );
  const paymentMethod = String(orderResult.rows[0]?.payment_method ?? "");
  const tracking = String(orderResult.rows[0]?.tracking_status ?? "");

  if (isPffPaymentMethod(paymentMethod)) {
    if (tracking === "ROUTES_READY" || tracking === "PICKUP_AVAILABLE" || tracking === "PAYMENT_DELIVERED" || tracking === "PICKED_UP" || tracking === "IN_TRANSIT" || tracking === "DELIVERED") {
      return;
    }
    const { payment, goods } = await loadPffSelectionStatuses(orderId);
    if (payment === "confirmed" && goods === "confirmed") return;
    throw new SegmentTrackingError(
      "Both payment and goods routes must be confirmed before updating segment status",
      400,
    );
  }

  const result = await pool.query(
    `SELECT status FROM route_selections WHERE order_id = $1 AND route_purpose = 'standard'`,
    [orderId],
  );
  if (result.rowCount === 0 || String(result.rows[0].status) !== "confirmed") {
    throw new SegmentTrackingError("Route must be confirmed before updating segment status", 400);
  }
}

async function loadPffSelectionStatuses(
  orderId: number,
): Promise<{ payment: string | null; goods: string | null }> {
  const result = await pool.query(
    `SELECT route_purpose, status FROM route_selections WHERE order_id = $1 AND route_purpose IN ('payment', 'goods')`,
    [orderId],
  );
  let payment: string | null = null;
  let goods: string | null = null;
  for (const row of result.rows) {
    const purpose = String(row.route_purpose);
    const status = String(row.status);
    if (purpose === "payment") payment = status;
    if (purpose === "goods") goods = status;
  }
  return { payment, goods };
}

async function getPaymentRouteId(orderId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT selected_route_id FROM route_selections
     WHERE order_id = $1 AND route_purpose = 'payment' AND status = 'confirmed'`,
    [orderId],
  );
  if (result.rowCount === 0) return null;
  return Number(result.rows[0].selected_route_id);
}

async function assertPickupReadyForSegment(seg: SegmentRow): Promise<void> {
  const isPff = isPffPaymentMethod(seg.payment_method);
  const isPaymentLeg = seg.leg_phase === "payment";
  const isGoodsLeg = seg.leg_phase === "goods";

  const result = await pool.query(
    `SELECT pickup_ready_at, goods_ready_at FROM orders WHERE id = $1`,
    [seg.order_id]
  );
  const pickupReady = Boolean(result.rows[0]?.pickup_ready_at);
  const goodsReady = Boolean(result.rows[0]?.goods_ready_at);

  if (isPff && isPaymentLeg) {
    if (!pickupReady) {
      throw new SegmentTrackingError(
        "Receiver must mark payment pickup available before transporters can collect",
        400
      );
    }
    return;
  }

  if (isPff && isGoodsLeg) {
    if (!goodsReady) {
      throw new SegmentTrackingError(
        "Sender must mark goods ready before the goods leg can begin",
        400
      );
    }
    return;
  }

  if (!pickupReady) {
    throw new SegmentTrackingError("Sender must mark pickup as ready first", 400);
  }
}

async function getPreviousLegStatusInPhase(
  routeId: number,
  segmentIndex: number,
  legPhase: string | null
): Promise<SegmentLegStatus | null> {
  const result = await pool.query(
    `SELECT sc.leg_status
     FROM route_segment_costs rsc
     JOIN segment_confirmations sc ON sc.segment_id = rsc.id
     WHERE rsc.route_id = $1
       AND rsc.segment_index < $2
       AND ($3::text IS NULL OR rsc.leg_phase IS NOT DISTINCT FROM $3)
     ORDER BY rsc.segment_index DESC
     LIMIT 1`,
    [routeId, segmentIndex, legPhase]
  );
  if (result.rowCount === 0) return null;
  const raw = result.rows[0].leg_status;
  return isSegmentLegStatus(raw) ? raw : "not_started";
}

async function paymentLegComplete(orderId: number, routeId?: number): Promise<boolean> {
  const paymentRouteId = routeId ?? (await getPaymentRouteId(orderId));
  if (paymentRouteId == null) return false;

  const result = await pool.query(
    `SELECT sc.leg_status
     FROM route_segment_costs rsc
     JOIN segment_confirmations sc ON sc.segment_id = rsc.id
     WHERE rsc.route_id = $1
     ORDER BY rsc.segment_index`,
    [paymentRouteId],
  );
  if (result.rowCount === 0) return true;
  const statuses: SegmentLegStatus[] = result.rows.map((row) =>
    isSegmentLegStatus(row.leg_status) ? row.leg_status : "not_started",
  );
  return phaseLegDelivered(statuses);
}

async function loadActiveLegSegments(orderId: number): Promise<
  { segment_index: number; leg_status: SegmentLegStatus; leg_phase: string | null }[]
> {
  const result = await pool.query(
    `SELECT rsc.segment_index, sc.leg_status, rsc.leg_phase, r.route_purpose
     FROM segment_confirmations sc
     JOIN route_segment_costs rsc ON rsc.id = sc.segment_id
     JOIN order_routes r ON r.id = sc.route_id
     JOIN route_selections rs
       ON rs.order_id = $1
      AND rs.selected_route_id = sc.route_id
      AND rs.status = 'confirmed'
     WHERE sc.status = 'accepted'
     ORDER BY
       CASE COALESCE(r.route_purpose, rsc.leg_phase)
         WHEN 'payment' THEN 0
         WHEN 'goods' THEN 1
         ELSE 2
       END,
       rsc.segment_index`,
    [orderId],
  );
  return result.rows.map((r) => ({
    segment_index: Number(r.segment_index),
    leg_status: isSegmentLegStatus(r.leg_status) ? r.leg_status : "not_started",
    leg_phase:
      r.leg_phase != null
        ? String(r.leg_phase)
        : r.route_purpose != null
          ? String(r.route_purpose)
          : null,
  }));
}

function paymentZoneCount(segments: { leg_phase: string | null }[]): number {
  return segments.filter((s) => s.leg_phase === "payment").length;
}

function legsComplete(legs: SegmentLegStatus[]): boolean {
  return legs.length > 0 && legs.every((l) => l === "in_transit");
}

/** Last segment must be in transit; earlier segments may stay picked_up once handoff continues. */
export function phaseLegDelivered(legStatuses: SegmentLegStatus[]): boolean {
  if (legStatuses.length === 0) return false;
  const last = legStatuses[legStatuses.length - 1];
  if (last !== "in_transit") return false;
  return legStatuses
    .slice(0, -1)
    .every((status) => status === "picked_up" || status === "in_transit");
}

export function deriveTrackingStatusFromLegs(
  legs: SegmentLegStatus[],
  pickupReady: boolean,
  options?: {
    isPff?: boolean;
    paymentLegCount?: number;
    goodsReady?: boolean;
    allSegments?: { segment_index: number; leg_status: SegmentLegStatus; leg_phase: string | null }[];
  }
): TrackingStatus {
  if (!pickupReady) return "CONFIRMED";

  const isPff = options?.isPff && (options.paymentLegCount ?? 0) > 0;
  const allSegments = options?.allSegments ?? [];

  if (isPff && allSegments.length > 0) {
    const paymentCount = options.paymentLegCount ?? paymentZoneCount(allSegments);
    const paymentLegs = allSegments
      .filter((s) => s.leg_phase === "payment")
      .sort((a, b) => a.segment_index - b.segment_index)
      .map((s) => s.leg_status);
    const goodsLegs = allSegments
      .filter((s) => s.leg_phase === "goods")
      .sort((a, b) => a.segment_index - b.segment_index)
      .map((s) => s.leg_status);

    if (paymentLegs.length > 0 && phaseLegDelivered(paymentLegs)) {
      if (!options?.goodsReady) return "PAYMENT_DELIVERED";
      if (goodsLegs.length === 0) return "PAYMENT_DELIVERED";
      if (phaseLegDelivered(goodsLegs)) return "IN_TRANSIT";
      const goodsFirstPicked =
        goodsLegs[0] === "picked_up" || goodsLegs[0] === "in_transit";
      const goodsAnyTransit = goodsLegs.some((l) => l === "in_transit");
      if (goodsAnyTransit || goodsLegs.every((l) => l === "in_transit")) {
        return "IN_TRANSIT";
      }
      if (goodsFirstPicked) {
        return goodsLegs.length === 1 ? "IN_TRANSIT" : "PICKED_UP";
      }
      return "PICKUP_AVAILABLE";
    }

    const paymentAnyTransit = paymentLegs.some((l) => l === "in_transit");
    const paymentFirstPicked =
      paymentLegs[0] === "picked_up" || paymentLegs[0] === "in_transit";
    if (paymentAnyTransit || paymentLegs.every((l) => l === "in_transit")) {
      return "IN_TRANSIT";
    }
    if (paymentFirstPicked) {
      return paymentLegs.length === 1 ? "IN_TRANSIT" : "PICKED_UP";
    }
    return "PICKUP_AVAILABLE";
  }

  let newStatus: TrackingStatus = "PICKUP_AVAILABLE";
  const allInTransit = legs.length > 0 && legs.every((l) => l === "in_transit");
  const anyInTransit = legs.some((l) => l === "in_transit");
  const firstPickedUp = legs[0] === "picked_up" || legs[0] === "in_transit";

  if (allInTransit || anyInTransit) {
    newStatus = "IN_TRANSIT";
  } else if (firstPickedUp) {
    newStatus = legs.length === 1 ? "IN_TRANSIT" : "PICKED_UP";
  }

  return newStatus;
}

export async function syncOrderTrackingFromSegments(orderId: number): Promise<TrackingStatus | null> {
  const pickupResult = await pool.query(
    `SELECT pickup_ready_at, goods_ready_at, tracking_status, payment_method FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!pickupResult.rows[0]?.pickup_ready_at) return null;

  const currentRaw = pickupResult.rows[0].tracking_status;
  const current: TrackingStatus = isTrackingStatus(currentRaw) ? currentRaw : "CONFIRMED";
  if (current === "DELIVERED") return "DELIVERED";

  const isPff = isPffPaymentMethod(String(pickupResult.rows[0].payment_method ?? ""));
  const goodsReady = Boolean(pickupResult.rows[0].goods_ready_at);
  const allSegments = await loadActiveLegSegments(orderId);
  if (allSegments.length === 0) return null;

  const legs = allSegments.map((s) => s.leg_status);
  const paymentLegCount = paymentZoneCount(allSegments);

  const newStatus = deriveTrackingStatusFromLegs(legs, true, {
    isPff,
    paymentLegCount,
    goodsReady,
    allSegments,
  });

  if (newStatus !== current) {
    await pool.query(
      `UPDATE orders SET tracking_status = $2, updated_at = NOW() WHERE id = $1`,
      [orderId, newStatus]
    );
    await syncLegacyOrderStatus(orderId, newStatus);

    if (newStatus === "PAYMENT_DELIVERED" && current !== "PAYMENT_DELIVERED") {
      await addStatusHistory(orderId, "PAYMENT_DELIVERED", null);
      void notifyOrderParticipants({
        order_id: orderId,
        type: "payment_delivered",
        title: "PFF payment delivered",
        body: `Payment package for shipment #${orderId} reached the producer. Prepare goods for pickup when ready.`,
      }).catch((err) => console.error("[notifications] payment_delivered failed:", err));
    }
  }

  return newStatus;
}

async function firstSegmentIndexForPhase(
  routeId: number,
  legPhase: string | null
): Promise<number | null> {
  const result = await pool.query(
    `SELECT MIN(segment_index)::int AS idx
     FROM route_segment_costs
     WHERE route_id = $1 AND ($2::text IS NULL OR leg_phase = $2)`,
    [routeId, legPhase]
  );
  const idx = result.rows[0]?.idx;
  return idx != null ? Number(idx) : null;
}

async function assertProducerHandoff(
  seg: SegmentRow,
  legStatus: SegmentLegStatus,
): Promise<void> {
  if (seg.handoff_role !== "goods_pickup" || legStatus !== "picked_up") return;

  const result = await pool.query(
    `SELECT rsc.transporter_id, sc.leg_status
     FROM route_segment_costs rsc
     JOIN segment_confirmations sc ON sc.segment_id = rsc.id
     JOIN route_selections rs
       ON rs.order_id = $1
      AND rs.route_purpose = 'payment'
      AND rs.selected_route_id = rsc.route_id
     WHERE rsc.handoff_role = 'payment_delivery'`,
    [seg.order_id],
  );
  if (result.rowCount === 0) return;

  const payment = result.rows[0];
  const paymentStatus = isSegmentLegStatus(payment.leg_status)
    ? payment.leg_status
    : "not_started";
  if (paymentStatus !== "in_transit") {
    throw new SegmentTrackingError(
      "Payment must be delivered to the producer before goods pickup can begin",
      400
    );
  }
  if (Number(payment.transporter_id) !== seg.transporter_id) {
    throw new SegmentTrackingError(
      "Producer handoff requires the same transporter who delivered the payment package",
      403
    );
  }
}

export async function updateSegmentLegStatus(
  segmentId: number,
  legStatus: SegmentLegStatus,
  ctx: OrderContext
): Promise<{ segment_id: number; leg_status: SegmentLegStatus; order_id: number }> {
  if (!isSegmentLegStatus(legStatus) || legStatus === "not_started") {
    throw new SegmentTrackingError("Invalid leg status. Allowed: picked_up, in_transit");
  }

  const seg = await loadSegment(segmentId);
  if (!seg) throw new SegmentTrackingError("Segment not found", 404);

  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new SegmentTrackingError("Forbidden", 403);
  }
  if (ctx.role === "driver" && seg.transporter_id !== ctx.userId) {
    throw new SegmentTrackingError("You are not assigned to this segment", 403);
  }
  if (seg.confirmation_status !== "accepted") {
    throw new SegmentTrackingError("Segment must be accepted before updating delivery status", 400);
  }
  if (seg.leg_status !== "not_started") {
    throw new SegmentTrackingError("This segment leg is already in progress or complete", 400);
  }

  await assertRouteConfirmedForOrder(seg.order_id);
  await assertPickupReadyForSegment(seg);

  const isPff = isPffPaymentMethod(seg.payment_method);
  const phaseFirstIndex = await firstSegmentIndexForPhase(
    seg.route_id,
    seg.leg_phase
  );
  const isPhaseFirst =
    phaseFirstIndex != null && seg.segment_index === phaseFirstIndex;

  const prevLeg = await getPreviousLegStatusInPhase(
    seg.route_id,
    seg.segment_index,
    seg.leg_phase
  );

  if (legStatus === "picked_up") {
    if (!isPhaseFirst) {
      throw new SegmentTrackingError(
        "Only the first segment of each leg can be marked as picked up",
        403
      );
    }
    if (isPff && seg.leg_phase === "goods" && !(await paymentLegComplete(seg.order_id))) {
      throw new SegmentTrackingError(
        "Payment leg must be completed before goods pickup can begin",
        400
      );
    }
    await assertProducerHandoff(seg, legStatus);
  } else if (legStatus === "in_transit") {
    if (isPhaseFirst) {
      throw new SegmentTrackingError("The first segment of a leg uses picked up only", 403);
    }
    const isSecondInPhase =
      phaseFirstIndex != null && seg.segment_index === phaseFirstIndex + 1;
    if (isSecondInPhase) {
      if (prevLeg !== "picked_up") {
        throw new SegmentTrackingError(
          "The first segment must be picked up before this segment can go in transit",
          400
        );
      }
    } else if (prevLeg !== "in_transit") {
      throw new SegmentTrackingError(
        "The previous segment must be in transit before this segment can start",
        400
      );
    }
  }

  await pool.query(
    `UPDATE segment_confirmations SET leg_status = $2 WHERE segment_id = $1`,
    [segmentId, legStatus]
  );

  const historyLabel = `SEG${seg.segment_index + 1}:${legStatus}`;
  await addStatusHistory(seg.order_id, historyLabel, ctx.userId);
  await syncOrderTrackingFromSegments(seg.order_id);

  const phaseLabel =
    seg.leg_phase === "payment"
      ? "payment"
      : seg.leg_phase === "goods"
        ? "goods"
        : "delivery";
  const legLabel = legStatus === "picked_up" ? "picked up" : "in transit";
  void notifyOrderParticipants({
    order_id: seg.order_id,
    type: legStatus === "picked_up" ? "segment_picked_up" : "segment_in_transit",
    title: `Segment ${legLabel}`,
    body: `${phaseLabel} segment ${seg.segment_index + 1} on shipment #${seg.order_id} was marked ${legLabel}.`,
    exclude_user_id: ctx.userId,
  }).catch((err) => console.error("[notifications] segment status failed:", err));

  return {
    segment_id: segmentId,
    leg_status: legStatus,
    order_id: seg.order_id,
  };
}

export { SEGMENT_LEG_STATUSES };
