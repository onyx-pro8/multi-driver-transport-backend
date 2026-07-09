import { latLngToCell } from "h3-js";
import { pool } from "../database";
import {
  OrderResponse,
  OrderRow,
  isOrderStatus,
  type OrderStatus,
} from "../models/order.model";
import { isTrackingStatus, type TrackingStatus } from "../models/orderTracking.model";
import type { RouteSelectionStatus } from "../models/routeConfirmation.model";
import { isPffPaymentMethod } from "../utils/paymentFlow";

const ROUTE_SELECTION_STATUSES = [
  "pending",
  "confirmed",
  "rejected",
  "partially_confirmed",
] as const;

function isRouteSelectionStatus(value: unknown): value is RouteSelectionStatus {
  return (
    typeof value === "string" &&
    (ROUTE_SELECTION_STATUSES as readonly string[]).includes(value)
  );
}

function aggregatePffRouteSelectionStatus(
  paymentStatus: string | null,
  goodsStatus: string | null,
): RouteSelectionStatus | null {
  if (!paymentStatus && !goodsStatus) return null;
  const statuses = [paymentStatus, goodsStatus].filter(Boolean) as string[];
  if (statuses.some((s) => s === "rejected")) return "rejected";
  if (statuses.length === 2 && statuses.every((s) => s === "confirmed")) return "confirmed";
  if (statuses.some((s) => s === "confirmed")) return "partially_confirmed";
  return "pending";
}
import type { UserRole } from "../models/userRole.model";
import { notifyOrderParticipants, notifyUsers } from "./notification.service";
import {
  CreateOrderRequest,
  CreateReceiverOrderRequest,
  UpdateOrderPackageRequest,
  UpdateOrderStatusRequest,
} from "../schemas/order.schema";
import {
  MAX_PACKAGES,
  normalizeOrderPackages,
  parseOrderPackagesFromStorage,
  rollupOrderTotalsFromPackages,
  totalPackageFactorForEntries,
  isPackageType,
} from "../models/package.model";
import type { OrderPackageEntry, PackageType } from "../models/package.model";
import {
  normalizePaymentPackages,
  parsePaymentPackagesFromStorage,
} from "../models/paymentPackage.model";
import { syncOrderTrackingFromSegments } from "./segment_tracking.service";

/**
 * H3 resolution at which order pickup / delivery coordinates are indexed.
 * Set to 15 — the finest (smallest) cell H3 supports — so pickup/drop-off
 * points resolve to the most precise cell possible.
 */
export const ORDER_H3_RESOLUTION = 15;

/** Safely convert a coordinate pair to an H3 index; null on any failure. */
function coordsToH3(
  lat: number | null,
  lng: number | null,
  resolution: number
): string | null {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  try {
    return latLngToCell(lat, lng, resolution);
  } catch {
    return null;
  }
}

export class OrderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Keep legacy orders.status in sync with tracking_status for list views still using it. */
export async function syncLegacyOrderStatus(
  orderId: number,
  trackingStatus: TrackingStatus
): Promise<void> {
  if (trackingStatus === "DELIVERED") {
    await pool.query(
      `UPDATE orders
       SET status = 'received',
           received_at = COALESCE(received_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );
    return;
  }

  if (
    trackingStatus === "PICKUP_AVAILABLE" ||
    trackingStatus === "PICKED_UP" ||
    trackingStatus === "IN_TRANSIT" ||
    trackingStatus === "PAYMENT_DELIVERED"
  ) {
    await pool.query(
      `UPDATE orders
       SET status = 'delivering',
           delivering_at = COALESCE(delivering_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND status = 'submitted'`,
      [orderId]
    );
  }
}

const ORDER_SELECT = `
  SELECT o.*,
         s.full_name AS sender_name,
         s.phone     AS sender_phone_user,
         r.full_name AS receiver_name,
         rs_std.status AS standard_route_selection_status,
         rs_std.selected_route_id AS standard_selected_route_id,
         std_r.route_label AS standard_selected_route_label,
         rs_pay.status AS payment_route_selection_status,
         rs_pay.selected_route_id AS payment_selected_route_id,
         pay_r.route_label AS payment_selected_route_label,
         rs_goods.status AS goods_route_selection_status,
         rs_goods.selected_route_id AS goods_selected_route_id,
         goods_r.route_label AS goods_selected_route_label
  FROM orders o
  JOIN users s ON s.id = o.sender_user_id
  JOIN users r ON r.id = o.receiver_user_id
  LEFT JOIN route_selections rs_std
    ON rs_std.order_id = o.id AND rs_std.route_purpose = 'standard'
  LEFT JOIN order_routes std_r ON std_r.id = rs_std.selected_route_id
  LEFT JOIN route_selections rs_pay
    ON rs_pay.order_id = o.id AND rs_pay.route_purpose = 'payment'
  LEFT JOIN order_routes pay_r ON pay_r.id = rs_pay.selected_route_id
  LEFT JOIN route_selections rs_goods
    ON rs_goods.order_id = o.id AND rs_goods.route_purpose = 'goods'
  LEFT JOIN order_routes goods_r ON goods_r.id = rs_goods.selected_route_id
  LEFT JOIN LATERAL (
    SELECT
      ROUND(COALESCE(SUM(sc.distance_km), 0)::numeric, 2) AS selected_route_total_distance_km,
      ROUND(
        COALESCE(
          SUM(CASE WHEN sc.transport_method = 'land' THEN sc.distance_km ELSE 0 END),
          0
        )::numeric,
        2
      ) AS selected_land_distance_km,
      ROUND(
        COALESCE(
          SUM(CASE WHEN sc.transport_method = 'sea' THEN sc.distance_km ELSE 0 END),
          0
        )::numeric,
        2
      ) AS selected_sea_distance_km,
      ROUND(
        COALESCE(
          SUM(CASE WHEN sc.transport_method = 'air' THEN sc.distance_km ELSE 0 END),
          0
        )::numeric,
        2
      ) AS selected_air_distance_km,
      COALESCE(
        json_agg(
          json_build_object(
            'route_id',
            sc.route_id,
            'route_purpose',
            r.route_purpose,
            'segment_index',
            sc.segment_index,
            'transport_method',
            sc.transport_method,
            'from_label',
            CASE
              WHEN sc.from_node_id = 'sender' THEN 'Sender'
              WHEN sc.from_node_id = 'receiver' THEN 'Receiver'
              ELSE COALESCE(zf.zone_name, CONCAT('Zone ', sc.from_node_id))
            END,
            'to_label',
            CASE
              WHEN sc.to_node_id = 'sender' THEN 'Sender'
              WHEN sc.to_node_id = 'receiver' THEN 'Receiver'
              ELSE COALESCE(zt.zone_name, CONCAT('Zone ', sc.to_node_id))
            END,
            'distance_km',
            CASE
              WHEN sc.distance_km IS NULL THEN NULL
              ELSE ROUND(sc.distance_km::numeric, 2)
            END
          )
          ORDER BY
            CASE r.route_purpose
              WHEN 'payment' THEN 0
              WHEN 'goods' THEN 1
              ELSE 2
            END,
            sc.segment_index
        ),
        '[]'::json
      ) AS selected_route_segments
    FROM route_segment_costs sc
    JOIN order_routes r ON r.id = sc.route_id
    LEFT JOIN driver_zones zf
      ON sc.from_node_id ~ '^\d+$'
     AND zf.id = sc.from_node_id::int
    LEFT JOIN driver_zones zt
      ON sc.to_node_id ~ '^\d+$'
     AND zt.id = sc.to_node_id::int
    WHERE sc.route_id IN (
      rs_std.selected_route_id,
      rs_pay.selected_route_id,
      rs_goods.selected_route_id
    )
  ) selected_route_distance ON TRUE
`;

function toNullable(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToOrder(row: Record<string, unknown>): OrderResponse {
  const status = isOrderStatus(row.status) ? (row.status as OrderStatus) : "submitted";
  const order: OrderRow = {
    id: Number(row.id),
    sender_user_id: Number(row.sender_user_id),
    receiver_user_id: Number(row.receiver_user_id),
    driver_user_id: row.driver_user_id !== null && row.driver_user_id !== undefined
      ? Number(row.driver_user_id)
      : null,
    sender_address: String(row.sender_address ?? ""),
    sender_billing_address: String(row.sender_billing_address ?? ""),
    sender_lat: toNullable(row.sender_lat),
    sender_lng: toNullable(row.sender_lng),
    destination_address: String(row.destination_address ?? ""),
    receiver_billing_address: String(row.receiver_billing_address ?? ""),
    destination_lat: toNullable(row.destination_lat),
    destination_lng: toNullable(row.destination_lng),
    receiver_phone: String(row.receiver_phone ?? ""),
    notes: String(row.notes ?? ""),
    pickup_h3: row.pickup_h3 != null ? String(row.pickup_h3) : null,
    delivery_h3: row.delivery_h3 != null ? String(row.delivery_h3) : null,
    h3_resolution: toNullable(row.h3_resolution),
    source_name: String(row.source_name ?? ""),
    source_contact: String(row.source_contact ?? ""),
    payment_method: String(row.payment_method ?? ""),
    shipping_method: String(row.shipping_method ?? ""),
    package_description: String(row.package_description ?? ""),
    package_type: isPackageType(row.package_type) ? row.package_type : null,
    packages: parseOrderPackagesFromStorage(
      row.packages,
      isPackageType(row.package_type) ? row.package_type : null,
      {
        weight_lbs: toNullable(row.weight_lbs),
        package_length: toNullable(row.package_length),
        package_width: toNullable(row.package_width),
        package_height: toNullable(row.package_height),
      }
    ),
    package_factor: toNullable(row.package_factor),
    payment_packages: parsePaymentPackagesFromStorage(row.payment_packages),
    payment_pickup_notified_at: row.payment_pickup_notified_at
      ? new Date(String(row.payment_pickup_notified_at))
      : null,
    weight_lbs:
      toNullable(row.weight_lbs) ??
      (String(row.package_weight_unit ?? "lb") === "kg" && row.weight_kg != null
        ? Math.round(Number(row.weight_kg) * 2.20462 * 1000) / 1000
        : toNullable(row.weight_kg)),
    package_weight_unit: String(row.package_weight_unit ?? "lb"),
    package_length: toNullable(row.package_length),
    package_width: toNullable(row.package_width),
    package_height: toNullable(row.package_height),
    package_dimension_unit: String(row.package_dimension_unit ?? "in"),
    dimensions: String(row.dimensions ?? ""),
    status,
    tracking_status: (isTrackingStatus(row.tracking_status)
      ? row.tracking_status
      : "CONFIRMED") as TrackingStatus,
    pickup_ready_at: row.pickup_ready_at ? new Date(String(row.pickup_ready_at)) : null,
    goods_ready_at: row.goods_ready_at ? new Date(String(row.goods_ready_at)) : null,
    route_schedule_at: row.route_schedule_at ? new Date(String(row.route_schedule_at)) : null,
    submitted_at: new Date(String(row.submitted_at)),
    delivering_at: row.delivering_at ? new Date(String(row.delivering_at)) : null,
    received_at: row.received_at ? new Date(String(row.received_at)) : null,
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };

  return {
    id: order.id,
    sender_user_id: order.sender_user_id,
    receiver_user_id: order.receiver_user_id,
    driver_user_id: order.driver_user_id,
    sender_name: String(row.sender_name ?? ""),
    sender_phone: String(row.sender_phone_user ?? ""),
    receiver_name: String(row.receiver_name ?? ""),
    receiver_phone: order.receiver_phone,
    sender_address: order.sender_address,
    sender_billing_address: order.sender_billing_address,
    sender_lat: order.sender_lat,
    sender_lng: order.sender_lng,
    destination_address: order.destination_address,
    receiver_billing_address: order.receiver_billing_address,
    destination_lat: order.destination_lat,
    destination_lng: order.destination_lng,
    notes: order.notes,
    pickup_h3: order.pickup_h3,
    delivery_h3: order.delivery_h3,
    h3_resolution: order.h3_resolution,
    source_name: order.source_name,
    source_contact: order.source_contact,
    payment_method: order.payment_method,
    shipping_method: order.shipping_method,
    package_description: order.package_description,
    package_type: order.package_type,
    packages: order.packages,
    package_factor: order.package_factor,
    payment_packages: order.payment_packages,
    payment_pickup_notified_at: order.payment_pickup_notified_at?.toISOString() ?? null,
    weight_lbs: order.weight_lbs,
    package_weight_unit: order.package_weight_unit,
    package_length: order.package_length,
    package_width: order.package_width,
    package_height: order.package_height,
    package_dimension_unit: order.package_dimension_unit,
    dimensions: order.dimensions,
    status: order.status,
    tracking_status: order.tracking_status,
    pickup_ready_at: order.pickup_ready_at?.toISOString() ?? null,
    goods_ready_at: order.goods_ready_at?.toISOString() ?? null,
    route_schedule_at: order.route_schedule_at?.toISOString() ?? null,
    route_selection_status: (() => {
      const isPff = isPffPaymentMethod(order.payment_method);
      if (isPff) {
        return aggregatePffRouteSelectionStatus(
          row.payment_route_selection_status != null
            ? String(row.payment_route_selection_status)
            : null,
          row.goods_route_selection_status != null
            ? String(row.goods_route_selection_status)
            : null,
        );
      }
      return isRouteSelectionStatus(row.standard_route_selection_status)
        ? row.standard_route_selection_status
        : null;
    })(),
    selected_route_id: (() => {
      const isPff = isPffPaymentMethod(order.payment_method);
      if (isPff) {
        const paymentId =
          row.payment_selected_route_id != null
            ? Number(row.payment_selected_route_id)
            : null;
        const goodsId =
          row.goods_selected_route_id != null
            ? Number(row.goods_selected_route_id)
            : null;
        return paymentId ?? goodsId;
      }
      return row.standard_selected_route_id != null
        ? Number(row.standard_selected_route_id)
        : null;
    })(),
    selected_route_label: (() => {
      const isPff = isPffPaymentMethod(order.payment_method);
      if (isPff) {
        const payLabel =
          row.payment_selected_route_label != null
            ? String(row.payment_selected_route_label)
            : null;
        const goodsLabel =
          row.goods_selected_route_label != null
            ? String(row.goods_selected_route_label)
            : null;
        if (payLabel && goodsLabel) return `${payLabel} / ${goodsLabel}`;
        return payLabel ?? goodsLabel;
      }
      return row.standard_selected_route_label != null
        ? String(row.standard_selected_route_label)
        : null;
    })(),
    selected_route_total_distance_km:
      row.selected_route_total_distance_km != null
        ? Number(row.selected_route_total_distance_km)
        : null,
    selected_route_method_distance_km: {
      land:
        row.selected_land_distance_km != null
          ? Number(row.selected_land_distance_km)
          : 0,
      sea:
        row.selected_sea_distance_km != null
          ? Number(row.selected_sea_distance_km)
          : 0,
      air:
        row.selected_air_distance_km != null
          ? Number(row.selected_air_distance_km)
          : 0,
    },
    selected_route_segments: Array.isArray(row.selected_route_segments)
      ? row.selected_route_segments.map((seg) => ({
          route_id: Number((seg as Record<string, unknown>).route_id),
          route_purpose: (() => {
            const purpose = (seg as Record<string, unknown>).route_purpose;
            if (purpose === "standard" || purpose === "payment" || purpose === "goods") {
              return purpose;
            }
            return null;
          })(),
          segment_index: Number((seg as Record<string, unknown>).segment_index),
          transport_method: String((seg as Record<string, unknown>).transport_method ?? ""),
          from_label: String((seg as Record<string, unknown>).from_label ?? ""),
          to_label: String((seg as Record<string, unknown>).to_label ?? ""),
          distance_km:
            (seg as Record<string, unknown>).distance_km != null
              ? Number((seg as Record<string, unknown>).distance_km)
              : null,
        }))
      : [],
    payment_route_selection_status: isRouteSelectionStatus(
      row.payment_route_selection_status,
    )
      ? row.payment_route_selection_status
      : null,
    goods_route_selection_status: isRouteSelectionStatus(
      row.goods_route_selection_status,
    )
      ? row.goods_route_selection_status
      : null,
    payment_selected_route_id:
      row.payment_selected_route_id != null
        ? Number(row.payment_selected_route_id)
        : null,
    goods_selected_route_id:
      row.goods_selected_route_id != null
        ? Number(row.goods_selected_route_id)
        : null,
    submitted_at: order.submitted_at.toISOString(),
    delivering_at: order.delivering_at?.toISOString() ?? null,
    received_at: order.received_at?.toISOString() ?? null,
    created_at: order.created_at.toISOString(),
    updated_at: order.updated_at.toISOString(),
  };
}

export interface OrderContext {
  userId: number;
  role: UserRole;
}

export async function createOrder(
  ctx: OrderContext,
  data: CreateOrderRequest
): Promise<OrderResponse> {
  if (ctx.role !== "admin") {
    throw new OrderError("Orders are created by receivers. Senders connect incoming requests.", 403);
  }

  const receiver = await pool.query(
    `SELECT id, role, full_name, phone, address, lat, lng FROM users WHERE id = $1`,
    [data.receiver_user_id]
  );
  if (receiver.rowCount === 0) throw new OrderError("Receiver not found", 404);
  const r = receiver.rows[0];
  if (r.role !== "receiver") {
    throw new OrderError("Selected user is not a receiver", 400);
  }

  const sender = await pool.query(
    `SELECT full_name, address, lat, lng FROM users WHERE id = $1`,
    [ctx.userId]
  );
  const senderRow = sender.rows[0] ?? {};

  const senderBillingAddress =
    data.sender_billing_address?.trim() || String(senderRow.address ?? "");
  const pickupAddress = data.sender_address?.trim() || senderBillingAddress;
  const senderLat = data.sender_lat ?? toNullable(senderRow.lat);
  const senderLng = data.sender_lng ?? toNullable(senderRow.lng);

  const receiverBillingAddress =
    data.receiver_billing_address?.trim() || String(r.address ?? "");
  const deliveryAddress =
    data.destination_address?.trim() || String(r.address ?? "");
  const destinationLat = data.destination_lat ?? toNullable(r.lat);
  const destinationLng = data.destination_lng ?? toNullable(r.lng);

  // Milestone 1 (updated scope): convert pickup + delivery coordinates to
  // H3 indexes and persist them with the order so later milestones (and the
  // order graph) reason about coverage without recomputing on every read.
  const pickupH3 = coordsToH3(senderLat, senderLng, ORDER_H3_RESOLUTION);
  const deliveryH3 = coordsToH3(destinationLat, destinationLng, ORDER_H3_RESOLUTION);

  const packages: OrderPackageEntry[] = normalizeOrderPackages(
    data.packages,
    data.package_type ?? null,
    {
      weight_lbs: data.weight_lbs,
      package_length: data.package_length,
      package_width: data.package_width,
      package_height: data.package_height,
    }
  );
  if (packages.length > MAX_PACKAGES) {
    throw new OrderError(`At most ${MAX_PACKAGES} packages are allowed`, 400);
  }
  const packageType: PackageType = packages[0].package_type;
  const packageFactor = totalPackageFactorForEntries(packages);
  const rolledUp = rollupOrderTotalsFromPackages(packages);
  const weightLbs = rolledUp.weight_lbs;
  const packageLength = rolledUp.package_length;
  const packageWidth = rolledUp.package_width;
  const packageHeight = rolledUp.package_height;
  const dimensionsText = data.dimensions?.trim() || rolledUp.dimensions;

  const insert = await pool.query(
    `INSERT INTO orders
       (sender_user_id, receiver_user_id, driver_user_id,
        sender_address, sender_billing_address, sender_lat, sender_lng,
        destination_address, receiver_billing_address, destination_lat, destination_lng,
        receiver_phone, notes,
        pickup_h3, delivery_h3, h3_resolution,
        source_name, source_contact, payment_method, shipping_method,
        package_description, package_type, packages, package_factor,
        weight_kg, weight_lbs, package_weight_unit,
        package_length, package_width, package_height, package_dimension_unit,
        dimensions,
        status, tracking_status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21, $22,
             $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
             'submitted', 'CONFIRMED', NOW())
     RETURNING id`,
    [
      ctx.userId,
      data.receiver_user_id,
      data.driver_user_id ?? null,
      pickupAddress,
      senderBillingAddress,
      senderLat,
      senderLng,
      deliveryAddress,
      receiverBillingAddress,
      destinationLat,
      destinationLng,
      String(r.phone ?? ""),
      data.notes ?? "",
      pickupH3,
      deliveryH3,
      ORDER_H3_RESOLUTION,
      data.source_name?.trim() || String(senderRow.full_name ?? ""),
      data.source_contact ?? "",
      data.payment_method ?? "",
      data.shipping_method ?? "",
      data.package_description ?? "",
      packageType,
      JSON.stringify(packages),
      packageFactor,
      weightLbs,
      weightLbs,
      "lb",
      packageLength,
      packageWidth,
      packageHeight,
      "in",
      dimensionsText,
    ]
  );

  const created = await getOrderById(Number(insert.rows[0].id), ctx);
  if (!created) throw new OrderError("Failed to load freshly created order", 500);
  return created;
}

export async function createOrderByReceiver(
  ctx: OrderContext,
  data: CreateReceiverOrderRequest
): Promise<OrderResponse> {
  if (ctx.role !== "receiver") {
    throw new OrderError("Only receivers can submit shipment requests", 403);
  }

  const sender = await pool.query(
    `SELECT id, role, full_name, phone, address, lat, lng FROM users WHERE id = $1`,
    [data.sender_user_id]
  );
  if (sender.rowCount === 0) throw new OrderError("Sender not found", 404);
  const s = sender.rows[0];
  if (s.role !== "sender") {
    throw new OrderError("Selected user is not a sender", 400);
  }

  const receiverRow = await pool.query(
    `SELECT full_name, phone, address FROM users WHERE id = $1`,
    [ctx.userId]
  );
  const r = receiverRow.rows[0] ?? {};

  const senderBillingAddress = String(s.address ?? "");
  const pickupAddress = senderBillingAddress;
  const senderLat = toNullable(s.lat);
  const senderLng = toNullable(s.lng);
  if (senderLat == null || senderLng == null) {
    throw new OrderError(
      "Selected sender has no pickup coordinates on file. They must update their profile before you can submit this request.",
      400
    );
  }

  const receiverBillingAddress =
    data.receiver_billing_address?.trim() || String(r.address ?? "");
  const deliveryAddress = data.destination_address.trim();
  const destinationLat = data.destination_lat;
  const destinationLng = data.destination_lng;

  const pickupH3 = coordsToH3(senderLat, senderLng, ORDER_H3_RESOLUTION);
  const deliveryH3 = coordsToH3(destinationLat, destinationLng, ORDER_H3_RESOLUTION);

  const packages: OrderPackageEntry[] = normalizeOrderPackages(
    data.packages,
    data.package_type ?? null,
    {
      weight_lbs: data.weight_lbs,
      package_length: data.package_length,
      package_width: data.package_width,
      package_height: data.package_height,
    }
  );
  if (packages.length > MAX_PACKAGES) {
    throw new OrderError(`At most ${MAX_PACKAGES} packages are allowed`, 400);
  }
  const packageType: PackageType = packages[0].package_type;
  const packageFactor = totalPackageFactorForEntries(packages);
  const rolledUp = rollupOrderTotalsFromPackages(packages);
  const weightLbs = rolledUp.weight_lbs;
  const packageLength = rolledUp.package_length;
  const packageWidth = rolledUp.package_width;
  const packageHeight = rolledUp.package_height;
  const dimensionsText = data.dimensions?.trim() || rolledUp.dimensions;

  const isPff = isPffPaymentMethod(data.payment_method);
  const paymentPackages = isPff
    ? normalizePaymentPackages(data.payment_packages)
    : normalizePaymentPackages(undefined);

  const insert = await pool.query(
    `INSERT INTO orders
       (sender_user_id, receiver_user_id, driver_user_id,
        sender_address, sender_billing_address, sender_lat, sender_lng,
        destination_address, receiver_billing_address, destination_lat, destination_lng,
        receiver_phone, notes,
        pickup_h3, delivery_h3, h3_resolution,
        source_name, source_contact, payment_method, shipping_method,
        package_description, package_type, packages, package_factor, payment_packages,
        weight_kg, weight_lbs, package_weight_unit,
        package_length, package_width, package_height, package_dimension_unit,
        dimensions,
        status, tracking_status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21, $22,
             $23::jsonb, $24, $25::jsonb, $26, $27, $28, $29, $30, $31, $32, $33,
             'submitted', 'AWAITING_CONNECT', NOW())
     RETURNING id`,
    [
      data.sender_user_id,
      ctx.userId,
      null,
      pickupAddress,
      senderBillingAddress,
      senderLat,
      senderLng,
      deliveryAddress,
      receiverBillingAddress,
      destinationLat,
      destinationLng,
      String(r.phone ?? ""),
      data.notes ?? "",
      pickupH3,
      deliveryH3,
      ORDER_H3_RESOLUTION,
      String(s.full_name ?? ""),
      String(s.phone ?? ""),
      data.payment_method ?? "",
      data.shipping_method ?? "",
      data.package_description ?? "",
      packageType,
      JSON.stringify(packages),
      packageFactor,
      JSON.stringify(paymentPackages),
      weightLbs,
      weightLbs,
      "lb",
      packageLength,
      packageWidth,
      packageHeight,
      "in",
      dimensionsText,
    ]
  );

  const orderId = Number(insert.rows[0].id);
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, updated_by) VALUES ($1, $2, $3)`,
    [orderId, "AWAITING_CONNECT", ctx.userId]
  );

  const created = await getOrderById(orderId, ctx);
  if (!created) throw new OrderError("Failed to load freshly created order", 500);

  void notifyUsers({
    user_ids: [data.sender_user_id],
    order_id: orderId,
    type: "order_request",
    title: "New shipment request",
    body: `${String(r.full_name ?? "A receiver")} submitted a shipment request to ${deliveryAddress}. Connect to build routes.`,
    exclude_user_id: ctx.userId,
  }).catch((err) => console.error("[notifications] order_request failed:", err));

  return created;
}

export async function connectOrderAsSender(
  orderId: number,
  ctx: OrderContext
): Promise<OrderResponse> {
  if (ctx.role !== "sender" && ctx.role !== "admin") {
    throw new OrderError("Only senders can connect shipment requests", 403);
  }

  const existing = await getOrderById(orderId, ctx);
  if (!existing) throw new OrderError("Order not found", 404);
  if (ctx.role === "sender" && existing.sender_user_id !== ctx.userId) {
    throw new OrderError("Forbidden", 403);
  }
  if (existing.tracking_status !== "AWAITING_CONNECT") {
    throw new OrderError("This order is already connected", 400);
  }

  await pool.query(
    `UPDATE orders SET tracking_status = 'CONFIRMED', updated_at = NOW() WHERE id = $1`,
    [orderId]
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, updated_by) VALUES ($1, $2, $3)`,
    [orderId, "CONFIRMED", ctx.userId]
  );

  const refreshed = await getOrderById(orderId, ctx);
  if (!refreshed) throw new OrderError("Failed to load order", 500);

  void notifyOrderParticipants({
    order_id: orderId,
    type: "order_connected",
    title: "Shipment connected",
    body: `Shipment #${orderId} was connected. Route options can now be compared and confirmations sent.`,
    exclude_user_id: ctx.userId,
  }).catch((err) => console.error("[notifications] order_connected failed:", err));

  return refreshed;
}

export async function rejectOrderAsSender(
  orderId: number,
  ctx: OrderContext,
  reason?: string
): Promise<OrderResponse> {
  if (ctx.role !== "sender" && ctx.role !== "admin") {
    throw new OrderError("Only senders can reject shipment requests", 403);
  }

  const existing = await getOrderById(orderId, ctx);
  if (!existing) throw new OrderError("Order not found", 404);
  if (ctx.role === "sender" && existing.sender_user_id !== ctx.userId) {
    throw new OrderError("Forbidden", 403);
  }
  if (existing.tracking_status !== "AWAITING_CONNECT") {
    throw new OrderError("Only pending shipment requests can be rejected", 400);
  }

  const noteSuffix = reason?.trim()
    ? `\n[Rejected by sender: ${reason.trim()}]`
    : "\n[Rejected by sender]";

  await pool.query(
    `UPDATE orders
     SET tracking_status = 'REJECTED',
         notes = CASE WHEN $2 = '' THEN notes ELSE TRIM(COALESCE(notes, '') || $2) END,
         updated_at = NOW()
     WHERE id = $1`,
    [orderId, noteSuffix]
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, updated_by) VALUES ($1, $2, $3)`,
    [orderId, "REJECTED", ctx.userId]
  );

  const refreshed = await getOrderById(orderId, ctx);
  if (!refreshed) throw new OrderError("Failed to load order", 500);

  void notifyUsers({
    user_ids: [existing.receiver_user_id],
    order_id: orderId,
    type: "order_request",
    title: "Shipment request rejected",
    body: `${String(existing.sender_name)} rejected shipment request #${orderId}.${reason?.trim() ? ` Reason: ${reason.trim()}` : ""}`,
    exclude_user_id: ctx.userId,
  }).catch((err) => console.error("[notifications] order_rejected failed:", err));

  return refreshed;
}

export async function updateOrderRouteSchedule(
  orderId: number,
  scheduleAt: string | null,
  ctx: OrderContext
): Promise<OrderResponse> {
  const existing = await getOrderById(orderId, ctx);
  if (!existing) throw new OrderError("Order not found", 404);
  if (ctx.role === "sender" && existing.sender_user_id !== ctx.userId) {
    throw new OrderError("Forbidden", 403);
  }
  if (ctx.role === "receiver" && existing.receiver_user_id !== ctx.userId) {
    throw new OrderError("Forbidden", 403);
  }
  if (ctx.role !== "sender" && ctx.role !== "receiver" && ctx.role !== "admin") {
    throw new OrderError("Forbidden", 403);
  }
  if (existing.tracking_status === "REJECTED") {
    throw new OrderError("Cannot schedule routes for a rejected order", 400);
  }

  let parsed: Date | null = null;
  if (scheduleAt != null && scheduleAt.trim() !== "") {
    parsed = new Date(scheduleAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new OrderError("Invalid route_schedule_at datetime", 400);
    }
  }

  await pool.query(
    `UPDATE orders SET route_schedule_at = $2, updated_at = NOW() WHERE id = $1`,
    [orderId, parsed]
  );

  const refreshed = await getOrderById(orderId, ctx);
  if (!refreshed) throw new OrderError("Failed to load order", 500);
  return refreshed;
}

export async function listOrders(ctx: OrderContext): Promise<OrderResponse[]> {
  const params: unknown[] = [];
  let where = "";
  if (ctx.role === "sender") {
    params.push(ctx.userId);
    where = `WHERE o.sender_user_id = $1`;
  } else if (ctx.role === "receiver") {
    params.push(ctx.userId);
    where = `WHERE o.receiver_user_id = $1`;
  } else if (ctx.role === "driver") {
    params.push(ctx.userId);
    where = `WHERE (
      o.driver_user_id = $1
      OR EXISTS (
        SELECT 1
        FROM route_segment_costs sc
        JOIN order_routes r ON r.id = sc.route_id
        WHERE r.order_id = o.id AND sc.transporter_id = $1
      )
    )`;
  }

  const result = await pool.query(
    `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC`,
    params
  );

  const needsSync = result.rows.filter(
    (row) =>
      isPffPaymentMethod(String(row.payment_method ?? "")) &&
      row.pickup_ready_at &&
      !["DELIVERED", "REJECTED", "AWAITING_CONNECT"].includes(String(row.tracking_status ?? ""))
  );
  if (needsSync.length > 0) {
    await Promise.all(
      needsSync.map((row) => syncOrderTrackingFromSegments(Number(row.id)))
    );
    const refreshed = await pool.query(
      `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC`,
      params
    );
    return refreshed.rows.map(rowToOrder);
  }

  return result.rows.map(rowToOrder);
}

export async function getOrderById(id: number, ctx: OrderContext): Promise<OrderResponse | null> {
  const params: unknown[] = [id];
  let extra = "";
  if (ctx.role === "sender") {
    params.push(ctx.userId);
    extra = ` AND o.sender_user_id = $${params.length}`;
  } else if (ctx.role === "receiver") {
    params.push(ctx.userId);
    extra = ` AND o.receiver_user_id = $${params.length}`;
  } else if (ctx.role === "driver") {
    params.push(ctx.userId);
    extra = ` AND (
      o.driver_user_id = $${params.length}
      OR EXISTS (
        SELECT 1
        FROM route_segment_costs sc
        JOIN order_routes r ON r.id = sc.route_id
        WHERE r.order_id = o.id AND sc.transporter_id = $${params.length}
      )
    )`;
  }
  const result = await pool.query(
    `${ORDER_SELECT} WHERE o.id = $1${extra}`,
    params
  );
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  if (
    isPffPaymentMethod(String(row.payment_method ?? "")) &&
    row.pickup_ready_at &&
    !["DELIVERED", "REJECTED", "AWAITING_CONNECT"].includes(String(row.tracking_status ?? ""))
  ) {
    await syncOrderTrackingFromSegments(id);
    const refreshed = await pool.query(
      `${ORDER_SELECT} WHERE o.id = $1${extra}`,
      params
    );
    if (refreshed.rowCount === 0) return null;
    return rowToOrder(refreshed.rows[0]);
  }

  return rowToOrder(row);
}

export async function updateOrderStatus(
  id: number,
  ctx: OrderContext,
  data: UpdateOrderStatusRequest
): Promise<OrderResponse> {
  const existing = await getOrderById(id, ctx);
  if (!existing) throw new OrderError("Order not found", 404);

  if (data.status === "delivering") {
    if (ctx.role !== "sender" && ctx.role !== "admin") {
      throw new OrderError("Only the sender can mark an order as delivering", 403);
    }
    if (existing.status !== "submitted") {
      throw new OrderError("Only submitted orders can be marked as delivering", 400);
    }
    await pool.query(
      `UPDATE orders SET status = 'delivering', delivering_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  } else if (data.status === "received") {
    if (ctx.role !== "receiver" && ctx.role !== "admin") {
      throw new OrderError("Only the receiver can mark an order as received", 403);
    }
    if (existing.status !== "delivering") {
      throw new OrderError("Only delivering orders can be marked as received", 400);
    }
    await pool.query(
      `UPDATE orders SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  const refreshed = await getOrderById(id, ctx);
  if (!refreshed) throw new OrderError("Failed to load order", 500);
  return refreshed;
}

export async function updateOrderPackage(
  id: number,
  ctx: OrderContext,
  data: UpdateOrderPackageRequest
): Promise<OrderResponse> {
  if (ctx.role !== "sender" && ctx.role !== "admin") {
    throw new OrderError("Only senders and admins can update package details", 403);
  }

  const existing = await getOrderById(id, ctx);
  if (!existing) throw new OrderError("Order not found", 404);
  if (existing.tracking_status === "AWAITING_CONNECT") {
    throw new OrderError("Package details can only be edited after the sender connects the order", 400);
  }
  if (existing.status !== "submitted") {
    throw new OrderError("Package details can only be edited while the order is submitted", 400);
  }

  const packages: OrderPackageEntry[] =
    data.packages != null || data.package_type != null
      ? normalizeOrderPackages(data.packages, data.package_type ?? existing.package_type, {
          weight_lbs: data.weight_lbs,
          package_length: data.package_length,
          package_width: data.package_width,
          package_height: data.package_height,
        })
      : existing.packages;
  if (packages.length > MAX_PACKAGES) {
    throw new OrderError(`At most ${MAX_PACKAGES} packages are allowed`, 400);
  }
  const packageType = packages[0]?.package_type ?? existing.package_type ?? "medium";
  const packageFactor = totalPackageFactorForEntries(packages);
  const rolledUp = rollupOrderTotalsFromPackages(packages);
  const weightLbs = rolledUp.weight_lbs;
  const packageLength = rolledUp.package_length;
  const packageWidth = rolledUp.package_width;
  const packageHeight = rolledUp.package_height;
  const packageDescription =
    data.package_description !== undefined
      ? data.package_description
      : existing.package_description;
  const dimensionsText = data.dimensions?.trim() || rolledUp.dimensions;

  await pool.query(
    `UPDATE orders
     SET package_type = $2,
         packages = $3::jsonb,
         package_factor = $4,
         weight_lbs = $5,
         weight_kg = $5,
         package_weight_unit = 'lb',
         package_length = $6,
         package_width = $7,
         package_height = $8,
         package_dimension_unit = 'in',
         package_description = $9,
         dimensions = $10,
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      packageType,
      JSON.stringify(packages),
      packageFactor,
      weightLbs,
      packageLength,
      packageWidth,
      packageHeight,
      packageDescription,
      dimensionsText,
    ]
  );

  const refreshed = await getOrderById(id, ctx);
  if (!refreshed) throw new OrderError("Failed to load order", 500);
  return refreshed;
}

/**
 * One-shot backfill: populate `pickup_h3` / `delivery_h3` (and the
 * resolution) for orders created before these columns existed, deriving
 * them from the coordinates already stored on the row. Idempotent — only
 * touches rows whose H3 is still NULL but which have coordinates. Safe to
 * run on every boot; it's a no-op once everything is filled.
 */
export async function backfillOrderH3(): Promise<number> {
  const result = await pool.query(
    `SELECT id, sender_lat, sender_lng, destination_lat, destination_lng
     FROM orders
     WHERE (pickup_h3 IS NULL AND sender_lat IS NOT NULL AND sender_lng IS NOT NULL)
        OR (delivery_h3 IS NULL AND destination_lat IS NOT NULL AND destination_lng IS NOT NULL)`
  );
  let updated = 0;
  for (const row of result.rows) {
    const pickupH3 = coordsToH3(
      toNullable(row.sender_lat),
      toNullable(row.sender_lng),
      ORDER_H3_RESOLUTION
    );
    const deliveryH3 = coordsToH3(
      toNullable(row.destination_lat),
      toNullable(row.destination_lng),
      ORDER_H3_RESOLUTION
    );
    await pool.query(
      `UPDATE orders
         SET pickup_h3 = COALESCE(pickup_h3, $2),
             delivery_h3 = COALESCE(delivery_h3, $3),
             h3_resolution = COALESCE(h3_resolution, $4)
       WHERE id = $1`,
      [Number(row.id), pickupH3, deliveryH3, ORDER_H3_RESOLUTION]
    );
    updated++;
  }
  return updated;
}

/**
 * Backfill package_type, weight_lbs, and unit defaults for legacy orders.
 */
export async function backfillOrderPricing(): Promise<number> {
  const result = await pool.query(
    `UPDATE orders
     SET package_type = COALESCE(package_type, 'medium'),
         package_factor = COALESCE(package_factor, 0.05),
         packages = COALESCE(
           packages,
           jsonb_build_array(jsonb_build_object('package_type', COALESCE(package_type, 'medium')))
         ),
         weight_lbs = COALESCE(
           weight_lbs,
           CASE
             WHEN package_weight_unit = 'kg' AND weight_kg IS NOT NULL
               THEN ROUND(weight_kg * 2.20462, 3)
             ELSE weight_kg
           END
         ),
         weight_kg = COALESCE(
           weight_lbs,
           CASE
             WHEN package_weight_unit = 'kg' AND weight_kg IS NOT NULL
               THEN ROUND(weight_kg * 2.20462, 3)
             ELSE weight_kg
           END
         ),
         package_weight_unit = 'lb',
         package_dimension_unit = 'in'
     WHERE package_type IS NULL
        OR package_factor IS NULL
        OR packages IS NULL
        OR weight_lbs IS NULL
        OR package_weight_unit IS DISTINCT FROM 'lb'
        OR package_dimension_unit IS DISTINCT FROM 'in'
     RETURNING id`
  );
  return result.rowCount ?? 0;
}
