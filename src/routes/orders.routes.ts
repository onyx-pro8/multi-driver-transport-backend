import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { latitudeSchema, longitudeSchema } from "../schemas/h3.schema";
import {
  createOrderSchema,
  createReceiverOrderSchema,
  updateOrderPackageSchema,
  updateOrderStatusSchema,
} from "../schemas/order.schema";
import {
  OrderError,
  connectOrderAsSender,
  createOrder,
  createOrderByReceiver,
  getOrderById,
  listOrders,
  rejectOrderAsSender,
  updateOrderPackage,
  updateOrderRouteSchedule,
  updateOrderStatus,
} from "../services/order.service";
import {
  DEFAULT_PREVIEW_MAX_DEPTH,
  previewOrderZoneConnectionsByCoordinates,
  previewOrderZoneConnectionsForOrder,
} from "../services/orderZoneConnection.service";
import {
  RouteCostError,
  compareOrderRoutes,
  recalculateRouteCostsForOrder,
} from "../services/routeCost.service";
import {
  RouteConfirmationError,
  getRouteSelections,
  getSelectedRoute,
} from "../services/route_confirmation.service";
import {
  getSenderOrderView,
  getReceiverOrderView,
  OrderViewError,
} from "../services/orderView.service";
import {
  getOrderStatus,
  updateOrderStatus as updateTrackingStatus,
  notifyPaymentPickedUpToSender,
  OrderStatusError,
} from "../services/order_status.service";
import { TRACKING_STATUSES } from "../models/orderTracking.model";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

const draftPreviewSchema = z.object({
  source_lat: latitudeSchema,
  source_lng: longitudeSchema,
  destination_lat: latitudeSchema,
  destination_lng: longitudeSchema,
  source_name: z.string().trim().max(200).optional(),
  source_address: z.string().trim().max(300).optional(),
  destination_name: z.string().trim().max(200).optional(),
  destination_address: z.string().trim().max(300).optional(),
  max_depth: z.coerce.number().int().positive().max(20).optional(),
});

function handle(res: Response, err: unknown) {
  if (err instanceof OrderError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof RouteCostError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof RouteConfirmationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof OrderViewError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof OrderStatusError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Order operation failed";
  console.error("[orders]", err);
  res.status(500).json({ error: message });
}

/**
 * POST /api/orders/zone-connection-preview
 *
 * Milestone 2 — let the sender preview the zone-connection graph between a
 * draft pickup coordinate and the receiver's drop-off coordinate before
 * actually submitting the order. This is a *preview only*: no order row is
 * created, no driver is assigned, no route is generated.
 *
 * Registered before `/:id` so "zone-connection-preview" isn't parsed as an
 * order id.
 */
ordersRouter.post(
  "/zone-connection-preview",
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = draftPreviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const c = ctx(req);
    // Milestone 4 — a sender *or* receiver can request the possible routes for
    // a draft order; admins can too. Drivers manage zones, not route requests.
    if (c.role !== "sender" && c.role !== "receiver" && c.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Only senders, receivers, and admins can request draft routes" });
    }
    try {
      const preview = await previewOrderZoneConnectionsByCoordinates({
        ...parsed.data,
        max_depth: parsed.data.max_depth ?? DEFAULT_PREVIEW_MAX_DEPTH,
      });
      res.json(preview);
    } catch (err) {
      handle(res, err);
    }
  }
);

ordersRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orders = await listOrders(ctx(req));
    res.json(orders);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id/selected-route", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const selection = await getSelectedRoute(id, ctx(req));
    if (!selection) return res.status(404).json({ error: "No route selected for this order" });
    res.json(selection);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id/route-selections", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const selections = await getRouteSelections(id, ctx(req));
    res.json(selections);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id/zone-connection-preview", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const purposeRaw = String(req.query.purpose ?? "goods");
  const routePurpose = purposeRaw === "payment" ? "payment" : "goods";
  try {
    const preview = await previewOrderZoneConnectionsForOrder(id, ctx(req), routePurpose);
    res.json(preview);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id/sender-view", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const view = await getSenderOrderView(id, ctx(req));
    res.json(view);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id/receiver-view", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const view = await getReceiverOrderView(id, ctx(req));
    res.json(view);
  } catch (err) {
    handle(res, err);
  }
});

const updateTrackingStatusSchema = z.object({
  status: z.enum(TRACKING_STATUSES),
});

ordersRouter.get("/:id/tracking-status", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const status = await getOrderStatus(id, ctx(req));
    res.json(status);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.patch("/:id/tracking-status", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const parsed = updateTrackingStatusSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const status = await updateTrackingStatus(id, parsed.data.status, ctx(req));
    res.json(status);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.post("/:id/notify-payment-pickup", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const status = await notifyPaymentPickedUpToSender(id, ctx(req));
    res.json(status);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id/route-cost-comparison", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const c = ctx(req);
  if (
    c.role !== "sender" &&
    c.role !== "receiver" &&
    c.role !== "admin" &&
    c.role !== "driver"
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const comparison = await compareOrderRoutes(id, c);
    res.json(comparison);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.post("/:id/recalculate-costs", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const c = ctx(req);
  if (c.role !== "sender" && c.role !== "receiver" && c.role !== "admin" && c.role !== "driver") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const scheduleAt =
    req.body && typeof req.body === "object" && "schedule_at" in req.body
      ? (req.body.schedule_at as string | null)
      : undefined;
  try {
    const comparison = await recalculateRouteCostsForOrder(id, c, scheduleAt);
    res.json(comparison);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const order = await getOrderById(id, ctx(req));
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.post("/:id/connect", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const c = ctx(req);
  try {
    await connectOrderAsSender(id, c);
    let routeRecalcWarning: string | null = null;
    try {
      await recalculateRouteCostsForOrder(id, c);
    } catch (recalcErr) {
      routeRecalcWarning =
        recalcErr instanceof RouteCostError
          ? recalcErr.message
          : recalcErr instanceof Error
            ? recalcErr.message
            : "Route calculation failed after connect";
      console.warn("[orders] connected but route cost recalc failed:", recalcErr);
    }
    const order = await getOrderById(id, c);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ ...order, route_recalc_warning: routeRecalcWarning });
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.post("/:id/reject", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const reason =
    req.body && typeof req.body === "object" && typeof req.body.reason === "string"
      ? req.body.reason
      : undefined;
  try {
    const order = await rejectOrderAsSender(id, ctx(req), reason);
    res.json(order);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.patch("/:id/route-schedule", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const parsed = z
    .object({
      schedule_at: z.string().nullable().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const order = await updateOrderRouteSchedule(
      id,
      parsed.data.schedule_at ?? null,
      ctx(req)
    );
    res.json(order);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const c = ctx(req);
  if (c.role === "receiver") {
    const parsed = createReceiverOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    try {
      const order = await createOrderByReceiver(c, parsed.data);
      return res.status(201).json(order);
    } catch (err) {
      return handle(res, err);
    }
  }
  if (c.role === "admin") {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    try {
      const order = await createOrder(c, parsed.data);
      return res.status(201).json(order);
    } catch (err) {
      return handle(res, err);
    }
  }
  return res.status(403).json({ error: "Only receivers can submit shipment requests" });
});

ordersRouter.patch("/:id/package", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const parsed = updateOrderPackageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const order = await updateOrderPackage(id, ctx(req), parsed.data);
    let route_cost_recalculated = false;
    try {
      await recalculateRouteCostsForOrder(id, ctx(req));
      route_cost_recalculated = true;
    } catch (recalcErr) {
      if (!(recalcErr instanceof RouteCostError && recalcErr.status === 404)) {
        console.warn("[orders] package updated but route cost recalc failed:", recalcErr);
      }
    }
    res.json({ order, route_cost_recalculated });
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.patch("/:id/status", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const parsed = updateOrderStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const order = await updateOrderStatus(id, ctx(req), parsed.data);
    res.json(order);
  } catch (err) {
    handle(res, err);
  }
});
