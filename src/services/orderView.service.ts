import { pool } from "../database";
import type { RouteCostSummaryResponse, ScheduleInactiveZoneSummary } from "../models/routeCost.model";
import type { RouteConfirmationStatusResponse } from "../models/routeConfirmation.model";
import type { OrderResponse } from "../models/order.model";
import type { TrackingStatus } from "../models/orderTracking.model";
import { isTrackingStatus } from "../models/orderTracking.model";
import { getOrderById, type OrderContext } from "./order.service";
import { compareOrderRoutes } from "./routeCost.service";
import {
  getRouteConfirmationStatus,
  getRouteSelections,
  getSelectedRoute,
  listTransporterConfirmations,
} from "./route_confirmation.service";
import { getOrderStatus } from "./order_status.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";

export class OrderViewError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface SenderOrderView {
  order: OrderResponse;
  tracking_status: TrackingStatus;
  all_routes: RouteCostSummaryResponse[];
  selected_route: Awaited<ReturnType<typeof getSelectedRoute>>;
  confirmation: RouteConfirmationStatusResponse | null;
  transporters: string[];
}

export interface ReceiverOrderView {
  order: OrderResponse;
  tracking_status: TrackingStatus;
  selected_route: Awaited<ReturnType<typeof getSelectedRoute>>;
  confirmation: RouteConfirmationStatusResponse | null;
  transporter_chain: string[];
  destination_zone_coverage: boolean;
}

export interface TransporterOrderViewItem {
  order_id: number;
  order_status: string;
  tracking_status: TrackingStatus;
  sender_address: string;
  destination_address: string;
  route_id: number;
  route_label: string;
  my_segments: {
    segment_id: number;
    segment_index: number;
    from_label: string;
    to_label: string;
    confirmation_status: string;
    cost_status: string;
    final_cost: number | null;
    package_weight_lbs: number | null;
    package_dimensions_in: string | null;
    zone_schedule_active: boolean | null;
    zone_schedule_summary: string | null;
    zone_schedule_inactive_reason: string | null;
  }[];
  upstream_transporter: string | null;
  downstream_transporter: string | null;
  package_type: string | null;
  package_weight_lbs: number | null;
  package_dimensions_in: string | null;
  schedule_inactive_zones: ScheduleInactiveZoneSummary[];
}

export async function getSenderOrderView(
  orderId: number,
  ctx: OrderContext
): Promise<SenderOrderView> {
  if (ctx.role !== "sender" && ctx.role !== "admin") {
    throw new OrderViewError("Forbidden", 403);
  }
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderViewError("Order not found", 404);

  const comparison = await compareOrderRoutes(orderId, ctx);
  const selections = await getRouteSelections(orderId, ctx);
  const isPff = isPffPaymentMethod(order.payment_method);
  const selected = isPff ? selections.goods : selections.standard;
  let confirmation: RouteConfirmationStatusResponse | null = null;
  if (selected) {
    confirmation = await getRouteConfirmationStatus(selected.selected_route_id, ctx);
  }

  const tracking = await getOrderStatus(orderId, ctx);
  const allRoutes = isPff
    ? [...(comparison.goods_routes ?? [])]
    : comparison.routes;
  const transporters =
    confirmation?.segments.map((s) => s.transporter_name) ??
    allRoutes[0]?.transporters ??
    [];

  return {
    order,
    tracking_status: tracking.tracking_status,
    all_routes: allRoutes,
    selected_route: selected,
    confirmation,
    transporters: [...new Set(transporters)],
  };
}

export async function getReceiverOrderView(
  orderId: number,
  ctx: OrderContext
): Promise<ReceiverOrderView> {
  if (ctx.role !== "receiver" && ctx.role !== "admin") {
    throw new OrderViewError("Forbidden", 403);
  }
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderViewError("Order not found", 404);

  const selections = await getRouteSelections(orderId, ctx);
  const isPff = isPffPaymentMethod(order.payment_method);
  const selected = isPff ? selections.payment : selections.standard;
  let confirmation: RouteConfirmationStatusResponse | null = null;
  let transporter_chain: string[] = [];
  if (selected) {
    confirmation = await getRouteConfirmationStatus(selected.selected_route_id, ctx);
    transporter_chain = confirmation.segments.map((s) => s.transporter_name);
  }

  const tracking = await getOrderStatus(orderId, ctx);

  // Check if delivery H3 cell falls within any zone on the selected route.
  let destination_zone_coverage = false;
  if (selected && order.delivery_h3) {
    const routeResult = await pool.query(
      `SELECT zone_ids FROM order_routes WHERE id = $1`,
      [selected.selected_route_id]
    );
    if (routeResult.rowCount) {
      const zoneIds: number[] = Array.isArray(routeResult.rows[0].zone_ids)
        ? routeResult.rows[0].zone_ids
        : JSON.parse(String(routeResult.rows[0].zone_ids ?? "[]"));
      if (zoneIds.length > 0) {
        const zoneCheck = await pool.query(
          `SELECT 1 FROM driver_zones
           WHERE id = ANY($1::int[])
             AND h3_cells ?| $2::text[]
           LIMIT 1`,
          [zoneIds, [order.delivery_h3]]
        );
        destination_zone_coverage = (zoneCheck.rowCount ?? 0) > 0;
      }
    }
  }

  return {
    order,
    tracking_status: tracking.tracking_status,
    selected_route: selected,
    confirmation,
    transporter_chain,
    destination_zone_coverage,
  };
}

export async function getTransporterOrders(
  ctx: OrderContext
): Promise<TransporterOrderViewItem[]> {
  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new OrderViewError("Forbidden", 403);
  }

  const confirmations = await listTransporterConfirmations(ctx);
  const byOrder = new Map<number, TransporterOrderViewItem>();

  for (const item of confirmations) {
    if (!byOrder.has(item.order_id)) {
      const orderResult = await pool.query(
        `SELECT status, tracking_status, sender_address, destination_address FROM orders WHERE id = $1`,
        [item.order_id]
      );
      const o = orderResult.rows[0];
      const rawTracking = o?.tracking_status;
      byOrder.set(item.order_id, {
        order_id: item.order_id,
        order_status: String(o?.status ?? "submitted"),
        tracking_status: isTrackingStatus(rawTracking) ? rawTracking : "PICKUP_AVAILABLE",
        sender_address: String(o?.sender_address ?? ""),
        destination_address: String(o?.destination_address ?? ""),
        route_id: item.route_id,
        route_label: item.route_label,
        my_segments: [],
        upstream_transporter: null,
        downstream_transporter: null,
        package_type: item.package_type ?? null,
        package_weight_lbs: item.package_weight_lbs ?? null,
        package_dimensions_in: item.package_dimensions_in ?? null,
        schedule_inactive_zones: item.schedule_inactive_zones ?? [],
      });
    }
    const entry = byOrder.get(item.order_id)!;

    const segCost = await pool.query(
      `SELECT cost_status, final_cost FROM route_segment_costs WHERE id = $1`,
      [item.segment_id]
    );
    const sc = segCost.rows[0];

    entry.my_segments.push({
      segment_id: item.segment_id,
      segment_index: item.segment_index,
      from_label: item.from_label,
      to_label: item.to_label,
      confirmation_status: item.status,
      cost_status: String(sc?.cost_status ?? "missing"),
      final_cost: sc?.final_cost != null ? Number(sc.final_cost) : null,
      package_weight_lbs: item.package_weight_lbs ?? null,
      package_dimensions_in: item.package_dimensions_in ?? null,
      zone_schedule_active: item.zone_schedule_active ?? null,
      zone_schedule_summary: item.zone_schedule_summary ?? null,
      zone_schedule_inactive_reason: item.zone_schedule_inactive_reason ?? null,
    });
  }

  // Enrich with upstream/downstream transporter names
  for (const entry of byOrder.values()) {
    const allSegs = await pool.query(
      `SELECT rsc.id, rsc.segment_index, u.full_name AS transporter_name
       FROM route_segment_costs rsc
       JOIN users u ON u.id = rsc.transporter_id
       WHERE rsc.route_id = $1
       ORDER BY rsc.segment_index`,
      [entry.route_id]
    );
    const myIndices = new Set(entry.my_segments.map((s) => s.segment_index));
    const segs = allSegs.rows.map((r) => ({
      index: Number(r.segment_index),
      name: String(r.transporter_name),
      isMine: myIndices.has(Number(r.segment_index)),
    }));
    const myMin = Math.min(...entry.my_segments.map((s) => s.segment_index));
    const myMax = Math.max(...entry.my_segments.map((s) => s.segment_index));
    entry.upstream_transporter =
      segs.find((s) => s.index === myMin - 1)?.name ?? null;
    entry.downstream_transporter =
      segs.find((s) => s.index === myMax + 1)?.name ?? null;
  }

  return [...byOrder.values()];
}
