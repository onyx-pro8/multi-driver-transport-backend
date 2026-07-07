import type { OrderContext } from "./order.service";

export interface PffRouteUpgradeResult {
  upgraded: boolean;
  route_ids: number[];
  reconfirmation_sent: boolean;
}

/** Legacy doubled-route upgrade is no longer used — PFF uses independent payment/goods routes. */
export async function ensurePffRouteSegmentsForOrder(
  _orderId: number,
  _ctx: OrderContext,
): Promise<PffRouteUpgradeResult> {
  return { upgraded: false, route_ids: [], reconfirmation_sent: false };
}
