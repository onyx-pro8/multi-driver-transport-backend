import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ensureSchema } from "./database";
import { ensureAdminUser } from "./services/auth.service";
import { authRouter } from "./routes/auth.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { h3Router } from "./routes/h3.routes";
import { driverZonesRouter } from "./routes/driverZones.routes";
import { driverZoneGraphRouter } from "./routes/driverZoneGraph.routes";
import { ordersRouter } from "./routes/orders.routes";
import { orderGraphRouter } from "./routes/orderGraph.routes";
import { backfillOrderH3, backfillOrderPricing } from "./services/order.service";
import { usersRouter } from "./routes/users.routes";
import {
  zoneConnectionsRouter,
  zonesScopedConnectionsRouter,
} from "./routes/zoneConnections.routes";
import { rateTablesRouter } from "./routes/rateTables.routes";
import { pricingRouter } from "./routes/pricing.routes";
import { routesCostRouter, routeSegmentCostsRouter } from "./routes/routeCost.routes";
import { routeConfirmationRouter } from "./routes/routeConfirmation.routes";
import { segmentsRouter } from "./routes/routeConfirmation.routes";
import { transporterRouter } from "./routes/transporter.routes";
import { notificationsRouter } from "./routes/notifications.routes";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// Comma-separated list of allowed origins. Supports a single value or many,
// and tolerates a trailing slash. Use "*" to allow all (not recommended with credentials).
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Allow same-origin / curl / server-to-server requests (no Origin header).
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes("*")) return callback(null, true);
    const normalized = origin.replace(/\/$/, "");
    if (allowedOrigins.includes(normalized)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "multi-driver-h3-backend",
    milestone: 7,
    auth: true,
    features: [
      "zones",
      "orders",
      "follows",
      "zone-connections",
      "driver-zone-graph",
      "order-graph",
      "route-cost",
      "route-confirmation",
      "order-tracking",
      "role-based-views",
      "pricing-config",
      "pricing-regions",
      "transporter-rate-tables-deprecated",
    ],
  });
});

app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/h3", h3Router);
app.use("/api/driver-zones", driverZonesRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/users", usersRouter);
app.use("/api/zone-connections", zoneConnectionsRouter);
// Spec wants the per-zone helpers exposed under /api/zones/:id/... — we
// mount them on a separate scoped router so the matching is precise.
app.use("/api/zones", zonesScopedConnectionsRouter);
// Milestone 3 — Driver-Zone Graph builder.
app.use("/api/driver-zone-graph", driverZoneGraphRouter);
// Milestone 3 — Order-based transporter graph (sender → receiver).
app.use("/api/order-graph", orderGraphRouter);
// Milestone 5 — Transporter rate tables (deprecated) + route cost + pricing config.
app.use("/api/transporter-rate-tables", rateTablesRouter);
app.use("/api/pricing", pricingRouter);
app.use("/api/routes", routesCostRouter);
app.use("/api/routes", routeConfirmationRouter);
app.use("/api/route-segment-costs", routeSegmentCostsRouter);
app.use("/api/segments", segmentsRouter);
app.use("/api/transporter", transporterRouter);
app.use("/api/notifications", notificationsRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.originalUrl });
});

// Centralized error handler.
// Keeps the API response shape clean and predictable across all routes.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal Server Error";
  console.error("[error]", err);
  res.status(500).json({ error: message });
});

async function bootstrap() {
  await ensureSchema();
  await ensureAdminUser();
  // Warm the land-polygon mask used by sea routing so the first sea-route
  // request doesn't pay the file-load cost mid-request.
  try {
    const { ensureLandMaskLoaded } = await import("./services/landMask.service");
    ensureLandMaskLoaded();
    console.log("[sea-route] land mask ready");
  } catch (err) {
    console.error("[sea-route] land mask preload failed:", err);
  }
  // Backfill H3 indexes for pre-existing orders (best-effort; never blocks
  // startup if it fails — new orders compute H3 at creation time anyway).
  try {
    const filled = await backfillOrderH3();
    if (filled > 0) console.log(`[db] backfilled H3 for ${filled} order(s)`);
  } catch (err) {
    console.error("[db] order H3 backfill failed:", err);
  }
  try {
    const priced = await backfillOrderPricing();
    if (priced > 0) console.log(`[db] backfilled package pricing for ${priced} order(s)`);
  } catch (err) {
    console.error("[db] order pricing backfill failed:", err);
  }
  app.listen(PORT, () => {
    console.log(`API ready on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
