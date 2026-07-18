import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../dependencies/auth.middleware";
import { convertRequestSchema, ConvertResponse } from "../schemas/h3.schema";
import { polygonToCellsSchema } from "../schemas/h3Polygon.schema";
import { cellCenter, H3Resolution, pointToCell } from "../services/h3_service";
import { hierarchicalPolygonCells } from "../services/hierarchicalFill";
import { computeLandRoute } from "../services/roadRouting.service";
import { computeSeaRoute } from "../services/seaRoute.service";

const seaRouteQuerySchema = z.object({
  from_lat: z.coerce.number().min(-90).max(90),
  from_lng: z.coerce.number().min(-180).max(180),
  to_lat: z.coerce.number().min(-90).max(90),
  to_lng: z.coerce.number().min(-180).max(180),
});

const landRouteQuerySchema = seaRouteQuerySchema;

export const h3Router = Router();

h3Router.use(requireAuth);

h3Router.post("/convert", (req: Request, res: Response) => {
  const parsed = convertRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, resolution } = parsed.data;

  try {
    const h3Resolution = resolution as H3Resolution;
    const pickup_h3 = pointToCell(pickup_lat, pickup_lng, h3Resolution);
    const dropoff_h3 = pointToCell(dropoff_lat, dropoff_lng, h3Resolution);

    const body: ConvertResponse = {
      pickup_h3,
      dropoff_h3,
      resolution,
      cell_type: "Hexagon",
      pickup_center: cellCenter(pickup_h3),
      dropoff_center: cellCenter(dropoff_h3),
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "H3 conversion failed";
    return res.status(400).json({ error: message });
  }
});

/** Shortest maritime path between two coordinates (for sea zone previews). */
h3Router.get("/sea-route", (req: Request, res: Response) => {
  const parsed = seaRouteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { from_lat, from_lng, to_lat, to_lng } = parsed.data;
  try {
    const coordinates = computeSeaRoute(
      { lat: from_lat, lng: from_lng },
      { lat: to_lat, lng: to_lng }
    );
    return res.json({ coordinates });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sea route failed";
    return res.status(500).json({ error: message });
  }
});

/** Land path that avoids cutting across open water (Google or land-grid A*). */
h3Router.get("/land-route", async (req: Request, res: Response) => {
  const parsed = landRouteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { from_lat, from_lng, to_lat, to_lng } = parsed.data;
  try {
    const route = await computeLandRoute(
      { lat: from_lat, lng: from_lng },
      { lat: to_lat, lng: to_lng }
    );
    return res.json({
      coordinates: route.coordinates ?? null,
      distance_km: route.distance_km,
      source: route.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Land route failed";
    return res.status(500).json({ error: message });
  }
});

h3Router.post("/polygon-to-cells", (req: Request, res: Response) => {
  const parsed = polygonToCellsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { boundary, resolution } = parsed.data;
  try {
    const h3Resolution = resolution as H3Resolution;
    const result = hierarchicalPolygonCells(boundary, {
      maxRes: h3Resolution,
      maxCells: 8000,
    });
    return res.json({
      h3_cells: result.cells,
      cell_count: result.cellCount,
      resolution: result.maxResolution,
      min_resolution: result.minResolution,
      max_resolution: result.maxResolution,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Polygon conversion failed";
    return res.status(400).json({ error: message });
  }
});
