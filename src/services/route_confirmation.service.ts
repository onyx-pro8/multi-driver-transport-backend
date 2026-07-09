import { pool } from "../database";
import { isTrackingStatus } from "../models/orderTracking.model";
import type {
  RouteConfirmationStatusResponse,
  RouteSelectionResponse,
  RouteSelectionStatus,
  RoutePurpose,
  PffRouteSelectionsResponse,
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
import type { ScheduleInactiveZoneSummary } from "../models/routeCost.model";
import {
  DEFAULT_PREVIEW_MAX_DEPTH,
  previewOrderZoneConnectionsByCoordinates,
} from "./orderZoneConnection.service";
import {
  buildZoneScheduleFields,
  describeZoneScheduleInactiveReason,
  formatZoneScheduleSummary,
  hasCompleteZoneSchedule,
  isZoneScheduleActive,
  parseScheduleFromRow,
} from "./zoneSchedule.service";
import { parsePaymentPackagesFromStorage } from "../models/paymentPackage.model";

function parseJsonIntArray(raw: unknown): number[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

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

function mapSelectionRow(row: Record<string, unknown>): RouteSelectionResponse {
  return {
    id: Number(row.id),
    order_id: Number(row.order_id),
    selected_route_id: Number(row.selected_route_id),
    selected_by_user_id: Number(row.selected_by_user_id),
    status: String(row.status) as RouteSelectionStatus,
    payment_status: String(row.payment_status) as "pending" | "ready" | "not_required",
    route_purpose: String(row.route_purpose ?? "standard") as RoutePurpose,
    route_label: String(row.route_label),
    created_at: new Date(row.created_at as string | Date).toISOString(),
    updated_at: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function assertRoutePurposeAccess(
  routePurpose: RoutePurpose | null,
  ctx: OrderContext,
  senderId: number,
  receiverId: number,
): void {
  if (ctx.role === "admin") return;
  if (routePurpose === "payment" && ctx.userId !== receiverId) {
    throw new RouteConfirmationError("Only the receiver can select the payment route", 403);
  }
  if (routePurpose === "goods" && ctx.userId !== senderId) {
    throw new RouteConfirmationError("Only the sender can select the goods route", 403);
  }
}

async function getPffSelectionsFromDb(
  orderId: number,
): Promise<{ payment: RouteSelectionResponse | null; goods: RouteSelectionResponse | null }> {
  const result = await pool.query(
    `SELECT rs.*, r.route_label
     FROM route_selections rs
     JOIN order_routes r ON r.id = rs.selected_route_id
     WHERE rs.order_id = $1 AND rs.route_purpose IN ('payment', 'goods')`,
    [orderId],
  );
  let payment: RouteSelectionResponse | null = null;
  let goods: RouteSelectionResponse | null = null;
  for (const row of result.rows) {
    const mapped = mapSelectionRow(row);
    if (mapped.route_purpose === "payment") payment = mapped;
    if (mapped.route_purpose === "goods") goods = mapped;
  }
  return { payment, goods };
}

async function tryFinalizePffOrder(orderId: number): Promise<void> {
  const { payment, goods } = await getPffSelectionsFromDb(orderId);
  const paymentOk = payment?.status === "confirmed";
  const goodsOk = goods?.status === "confirmed";

  if (paymentOk && goodsOk) {
    await pool.query(
      `UPDATE orders SET tracking_status = 'ROUTES_READY', updated_at = NOW() WHERE id = $1`,
      [orderId],
    );
    await addStatusHistory(orderId, "ROUTES_READY", null);
    void notifyOrderParticipants({
      order_id: orderId,
      type: "route_confirmed",
      title: "Both routes confirmed",
      body: `Payment and goods routes are fully confirmed for shipment #${orderId}. Payment pickup can be scheduled when ready.`,
    }).catch((err) => console.error("[notifications] pff_routes_ready failed:", err));
    return;
  }

  if (payment || goods) {
    await pool.query(
      `UPDATE orders
       SET tracking_status = 'ROUTES_IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND tracking_status = 'CONFIRMED'`,
      [orderId],
    );
  }
}

export async function selectRoute(
  orderId: number,
  routeId: number,
  userId: number,
  ctx: OrderContext,
): Promise<RouteSelectionResponse> {
  const { senderId, receiverId } = await assertSenderReceiverAccess(orderId, ctx);

  if (await isOrderRouteLocked(orderId)) {
    throw new RouteConfirmationError(
      "Cannot change route after confirmation or while delivery is in progress",
      409,
    );
  }

  const route = await loadRouteForOrder(routeId, orderId);
  if (!route) throw new RouteConfirmationError("Route not found for this order", 404);

  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteConfirmationError("Order not found", 404);

  const isPff = isPffPaymentMethod(order.payment_method);
  const routePurposeRaw =
    route.route_purpose != null ? String(route.route_purpose) : null;

  let selectionPurpose: RoutePurpose = "standard";
  if (isPff) {
    if (routePurposeRaw === "payment") selectionPurpose = "payment";
    else if (routePurposeRaw === "goods") selectionPurpose = "goods";
    else {
      throw new RouteConfirmationError(
        "PFF orders require selecting a payment or goods route candidate",
        400,
      );
    }
    assertRoutePurposeAccess(selectionPurpose, ctx, senderId, receiverId);
  } else if (ctx.role !== "admin" && ctx.userId !== senderId && ctx.userId !== receiverId) {
    throw new RouteConfirmationError("Forbidden", 403);
  }

  await calculateRouteCost(routeId, ctx);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO route_selections
         (order_id, selected_route_id, selected_by_user_id, status, payment_status, route_purpose)
       VALUES ($1, $2, $3, 'pending', 'pending', $4)
       ON CONFLICT (order_id, route_purpose) DO UPDATE
         SET selected_route_id = EXCLUDED.selected_route_id,
             selected_by_user_id = EXCLUDED.selected_by_user_id,
             status = 'pending',
             payment_status = 'pending',
             updated_at = NOW()`,
      [orderId, routeId, userId, selectionPurpose],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await sendConfirmationToTransporters(routeId, ctx);

  if (isPff) {
    await tryFinalizePffOrder(orderId);
  }

  const selections = await getRouteSelections(orderId, ctx);
  if (isPff) {
    const picked =
      selectionPurpose === "payment" ? selections.payment : selections.goods;
    if (!picked) throw new RouteConfirmationError("Failed to load route selection", 500);
    return picked;
  }
  if (!selections.standard) {
    throw new RouteConfirmationError("Failed to load route selection", 500);
  }
  return selections.standard;
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
      `UPDATE route_selections rs
       SET status = 'pending', updated_at = NOW()
       FROM order_routes r
       WHERE r.id = $1 AND rs.selected_route_id = r.id AND rs.order_id = r.order_id`,
      [routeId],
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

async function downgradePffOrderAfterRejection(orderId: number): Promise<void> {
  const orderResult = await pool.query(
    `SELECT payment_method, tracking_status FROM orders WHERE id = $1`,
    [orderId],
  );
  if (orderResult.rowCount === 0) return;
  if (!isPffPaymentMethod(String(orderResult.rows[0].payment_method ?? ""))) return;

  const tracking = String(orderResult.rows[0].tracking_status ?? "");
  if (tracking !== "ROUTES_READY" && tracking !== "ROUTES_IN_PROGRESS") return;

  await pool.query(
    `UPDATE orders
     SET tracking_status = 'ROUTES_IN_PROGRESS', updated_at = NOW()
     WHERE id = $1 AND tracking_status IN ('ROUTES_READY', 'ROUTES_IN_PROGRESS')`,
    [orderId],
  );
  await addStatusHistory(orderId, "ROUTES_IN_PROGRESS", null);
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
    [routeId],
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

  await downgradePffOrderAfterRejection(orderId);

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
    [routeId],
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
    [routeId],
  );
  if (confResult.rowCount === 0) return;

  const statuses = confResult.rows.map((r) => String(r.status) as SegmentConfirmationStatus);
  const selectionStatus = computeSelectionStatus(
    statuses.map((status) => ({ status })),
  );

  const paymentStatus =
    selectionStatus === "confirmed"
      ? "ready"
      : selectionStatus === "rejected"
        ? "not_required"
        : "pending";

  await pool.query(
    `UPDATE route_selections rs
     SET status = $2, payment_status = $3, updated_at = NOW()
     FROM order_routes r
     WHERE r.id = $1 AND rs.selected_route_id = r.id AND rs.order_id = r.order_id`,
    [routeId, selectionStatus, paymentStatus],
  );

  const orderResult = await pool.query(
    `SELECT r.order_id, o.payment_method
     FROM order_routes r
     JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1`,
    [routeId],
  );
  if (!orderResult.rowCount) return;
  const orderId = Number(orderResult.rows[0].order_id);
  const isPff = isPffPaymentMethod(String(orderResult.rows[0].payment_method ?? ""));

  if (isPff) {
    await tryFinalizePffOrder(orderId);
    return;
  }

  if (selectionStatus === "confirmed") {
    await pool.query(
      `UPDATE orders o
       SET tracking_status = 'CONFIRMED', updated_at = NOW()
       FROM order_routes r
       WHERE r.id = $1 AND o.id = r.order_id`,
      [routeId],
    );
    await addStatusHistory(orderId, "CONFIRMED", null);
    void notifyOrderParticipants({
      order_id: orderId,
      type: "route_confirmed",
      title: "Route fully confirmed",
      body: `All transporters confirmed their segments for shipment #${orderId}. Pickup can be scheduled when ready.`,
    }).catch((err) => console.error("[notifications] route_confirmed failed:", err));
  }
}

export async function getRouteSelections(
  orderId: number,
  ctx: OrderContext,
): Promise<PffRouteSelectionsResponse & { standard: RouteSelectionResponse | null }> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteConfirmationError("Order not found", 404);

  const result = await pool.query(
    `SELECT rs.*, r.route_label
     FROM route_selections rs
     JOIN order_routes r ON r.id = rs.selected_route_id
     WHERE rs.order_id = $1`,
    [orderId],
  );

  let standard: RouteSelectionResponse | null = null;
  let payment: RouteSelectionResponse | null = null;
  let goods: RouteSelectionResponse | null = null;

  for (const row of result.rows) {
    const mapped = mapSelectionRow(row);
    if (mapped.route_purpose === "payment") payment = mapped;
    else if (mapped.route_purpose === "goods") goods = mapped;
    else standard = mapped;
  }

  return {
    standard,
    payment,
    goods,
    both_confirmed: payment?.status === "confirmed" && goods?.status === "confirmed",
  };
}

export async function getSelectedRoute(
  orderId: number,
  ctx: OrderContext,
): Promise<RouteSelectionResponse | null> {
  const selections = await getRouteSelections(orderId, ctx);
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteConfirmationError("Order not found", 404);

  if (isPffPaymentMethod(order.payment_method)) {
    return selections.payment ?? selections.goods;
  }
  return selections.standard;
}

function formatOrderPackageDimensions(row: Record<string, unknown>): string | null {
  if (
    row.package_length != null &&
    row.package_width != null &&
    row.package_height != null
  ) {
    return `${row.package_length} × ${row.package_width} × ${row.package_height} in`;
  }
  const dims = row.dimensions;
  return dims != null && String(dims).trim() !== "" ? String(dims) : null;
}

async function loadZoneScheduleStatusByIds(
  zoneIds: number[],
): Promise<Map<number, { active: boolean | null; summary: string | null; inactive_reason: string | null }>> {
  const unique = Array.from(new Set(zoneIds.filter((id) => id > 0)));
  const map = new Map<number, { active: boolean | null; summary: string | null; inactive_reason: string | null }>();
  if (unique.length === 0) return map;

  const result = await pool.query(
    `SELECT id, transport_mode, operation_date, operation_start_date, operation_end_date,
            schedule_pattern, weekday_start, weekday_end, month_day_start, month_day_end,
            operating_start_time, operating_end_time, departure_time, arrival_time
     FROM driver_zones WHERE id = ANY($1::int[])`,
    [unique],
  );

  for (const row of result.rows) {
    const id = Number(row.id);
    const schedule = parseScheduleFromRow(row);
    const fields = buildZoneScheduleFields({
      transport_mode: String(row.transport_mode ?? "land"),
      ...schedule,
    });
    if (!hasCompleteZoneSchedule(fields)) {
      map.set(id, {
        active: null,
        summary: null,
        inactive_reason: "No operating schedule configured",
      });
      continue;
    }
    const active = isZoneScheduleActive(fields);
    const inactive = describeZoneScheduleInactiveReason(fields);
    map.set(id, {
      active,
      summary: formatZoneScheduleSummary(fields),
      inactive_reason: active ? null : inactive?.label ?? "Not available at this time",
    });
  }
  return map;
}

async function ensureZoneScheduleCached(
  zoneIds: number[],
  cache: Map<number, { active: boolean | null; summary: string | null; inactive_reason: string | null }>,
): Promise<void> {
  const missing = zoneIds.filter((id) => id > 0 && !cache.has(id));
  if (missing.length === 0) return;
  const statusMap = await loadZoneScheduleStatusByIds(missing);
  for (const id of missing) {
    cache.set(id, statusMap.get(id) ?? { active: null, summary: null, inactive_reason: null });
  }
}

async function loadScheduleInactiveZonesForOrder(
  row: Record<string, unknown>,
): Promise<ScheduleInactiveZoneSummary[]> {
  if (
    row.sender_lat == null ||
    row.sender_lng == null ||
    row.destination_lat == null ||
    row.destination_lng == null
  ) {
    return [];
  }
  try {
    const preview = await previewOrderZoneConnectionsByCoordinates({
      source_lat: Number(row.sender_lat),
      source_lng: Number(row.sender_lng),
      destination_lat: Number(row.destination_lat),
      destination_lng: Number(row.destination_lng),
      source_name: row.source_name != null ? String(row.source_name) : undefined,
      source_address: row.sender_address != null ? String(row.sender_address) : undefined,
      destination_name:
        row.receiver_name != null ? String(row.receiver_name) : undefined,
      destination_address:
        row.destination_address != null ? String(row.destination_address) : undefined,
      max_depth: DEFAULT_PREVIEW_MAX_DEPTH,
      schedule_at:
        row.route_schedule_at != null
          ? new Date(String(row.route_schedule_at)).toISOString()
          : undefined,
    });
    return preview.schedule_inactive_zones ?? [];
  } catch {
    return [];
  }
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
            r.route_purpose,
            r.zone_ids,
            r.connection_ids,
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
            o.payment_packages,
            o.weight_lbs,
            o.package_length,
            o.package_width,
            o.package_height,
            o.dimensions,
            o.package_type,
            o.sender_lat,
            o.sender_lng,
            o.destination_lat,
            o.destination_lng,
            o.source_name,
            ru.full_name AS receiver_name,
            o.route_schedule_at,
            r.is_complete AS route_is_complete,
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
     JOIN users ru ON ru.id = o.receiver_user_id
     LEFT JOIN route_selections rs ON rs.order_id = r.order_id AND rs.selected_route_id = r.id
     LEFT JOIN route_confirmation_requests rcr ON rcr.segment_id = sc.segment_id
     WHERE sc.transporter_id = $1
     ORDER BY sc.created_at DESC`,
    [transporterId]
  );

  const summaryCache = new Map<
    number,
    Awaited<ReturnType<typeof getRouteCostSummary>> | null
  >();
  const scheduleInactiveCache = new Map<number, ScheduleInactiveZoneSummary[]>();
  const zoneScheduleCache = new Map<number, { active: boolean | null; summary: string | null; inactive_reason: string | null }>();

  const items: TransporterConfirmationItem[] = [];
  for (const row of result.rows) {
    const routeId = Number(row.route_id);
    const orderId = Number(row.order_id);
    if (!summaryCache.has(routeId)) {
      try {
        summaryCache.set(routeId, await getRouteCostSummary(routeId, ctx));
      } catch (err) {
        if (err instanceof RouteCostError) {
          summaryCache.set(routeId, null);
        } else {
          throw err;
        }
      }
    }
    const summary = summaryCache.get(routeId);
    const seg = summary?.segments.find((s) => s.segment_id === Number(row.segment_id));
    const zoneId = seg?.zone_id ?? null;

    if (!scheduleInactiveCache.has(orderId)) {
      scheduleInactiveCache.set(
        orderId,
        await loadScheduleInactiveZonesForOrder(row),
      );
    }

    if (zoneId != null) {
      await ensureZoneScheduleCached([zoneId], zoneScheduleCache);
    }
    const zoneSchedule =
      zoneId != null
        ? zoneScheduleCache.get(zoneId) ?? { active: null, summary: null, inactive_reason: null }
        : { active: null, summary: null, inactive_reason: null };

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
      route_purpose:
        row.route_purpose === "payment" || row.route_purpose === "goods"
          ? row.route_purpose
          : null,
      zone_ids: parseJsonIntArray(row.zone_ids),
      connection_ids: parseJsonIntArray(row.connection_ids),
      transport_method: seg?.transport_method ?? null,
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
      payment_packages: parsePaymentPackagesFromStorage(row.payment_packages),
      route_segment_count: Number(row.route_segment_count ?? 0),
      previous_leg_status: isSegmentLegStatus(row.previous_leg_status)
        ? row.previous_leg_status
        : row.previous_leg_status == null
          ? null
          : "not_started",
      final_cost: seg?.final_cost ?? null,
      distance_km: seg?.distance_km ?? null,
      currency: seg?.currency ?? "CAD",
      cost_status: seg?.cost_status ?? "missing",
      package_type: row.package_type != null ? String(row.package_type) : null,
      package_weight_lbs:
        row.weight_lbs != null ? Number(row.weight_lbs) : null,
      package_dimensions_in: formatOrderPackageDimensions(row),
      route_is_complete: row.route_is_complete !== false,
      schedule_inactive_zones: scheduleInactiveCache.get(orderId) ?? [],
      zone_id: zoneId,
      zone_schedule_active: zoneSchedule.active,
      zone_schedule_summary: zoneSchedule.summary,
      zone_schedule_inactive_reason: zoneSchedule.inactive_reason,
    });
  }

  return items;
}
