import { pool } from "../database";
import { expectedSegmentCountForRoute } from "./costCalculation.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";
import { getOrderById, type OrderContext } from "./order.service";
import { calculateRouteCost } from "./routeCost.service";
import { sendConfirmationToTransporters } from "./route_confirmation.service";
import { notifyOrderParticipants, createUserNotification } from "./notification.service";

export interface PffRouteUpgradeResult {
  upgraded: boolean;
  route_ids: number[];
  reconfirmation_sent: boolean;
}

async function isRouteSegmentationStale(
  routeId: number,
  zoneCount: number,
  isPff: boolean,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id, leg_phase FROM route_segment_costs WHERE route_id = $1`,
    [routeId],
  );
  const expected = expectedSegmentCountForRoute(zoneCount, isPff);
  if (result.rowCount !== expected) return true;
  if (!isPff) return false;
  return result.rows.some((r) => r.leg_phase == null);
}

/**
 * Upgrade legacy PFF routes (single-leg) to payment+goods segments and
 * re-issue transporter confirmations when a route was already selected.
 */
export async function ensurePffRouteSegmentsForOrder(
  orderId: number,
  ctx: OrderContext,
): Promise<PffRouteUpgradeResult> {
  const order = await getOrderById(orderId, ctx);
  if (!order || !isPffPaymentMethod(order.payment_method)) {
    return { upgraded: false, route_ids: [], reconfirmation_sent: false };
  }

  if (order.tracking_status === "DELIVERED") {
    return { upgraded: false, route_ids: [], reconfirmation_sent: false };
  }

  const routesResult = await pool.query(
    `SELECT id, zone_ids FROM order_routes WHERE order_id = $1 ORDER BY route_index`,
    [orderId],
  );
  if (routesResult.rowCount === 0) {
    return { upgraded: false, route_ids: [], reconfirmation_sent: false };
  }

  const selectionResult = await pool.query(
    `SELECT selected_route_id, status FROM route_selections WHERE order_id = $1`,
    [orderId],
  );
  const selectedRouteId =
    selectionResult.rowCount && selectionResult.rows[0].selected_route_id != null
      ? Number(selectionResult.rows[0].selected_route_id)
      : null;
  const hadActiveSelection =
    (selectionResult.rowCount ?? 0) > 0 &&
    ["confirmed", "partially_confirmed", "pending"].includes(
      String(selectionResult.rows[0].status),
    );

  const upgradedRouteIds: number[] = [];
  let reconfirmationSent = false;

  for (const row of routesResult.rows) {
    const routeId = Number(row.id);
    const zoneIds = Array.isArray(row.zone_ids)
      ? row.zone_ids
      : JSON.parse(String(row.zone_ids ?? "[]"));
    const zoneCount = zoneIds.length;
    const stale = await isRouteSegmentationStale(routeId, zoneCount, true);
    if (!stale) continue;

    await calculateRouteCost(routeId, ctx);
    upgradedRouteIds.push(routeId);

    if (selectedRouteId === routeId && hadActiveSelection) {
      await sendConfirmationToTransporters(routeId, ctx);
      reconfirmationSent = true;

      void notifyOrderParticipants({
        order_id: orderId,
        type: "confirmation_request",
        title: "PFF route updated — reconfirm required",
        body: `Shipment #${orderId}: the route now includes payment and goods legs. Transporters must accept their updated segments.`,
      }).catch((err) => console.error("[notifications] pff_upgrade failed:", err));

      if (order.receiver_user_id) {
        void createUserNotification({
          user_id: order.receiver_user_id,
          order_id: orderId,
          type: "general",
          title: "PFF route structure updated",
          body: `Shipment #${orderId} now uses the full round-trip route (payment + goods). Wait for transporter confirmations before pickup.`,
        }).catch((err) => console.error("[notifications] pff_upgrade receiver failed:", err));
      }
    }
  }

  return {
    upgraded: upgradedRouteIds.length > 0,
    route_ids: upgradedRouteIds,
    reconfirmation_sent: reconfirmationSent,
  };
}
