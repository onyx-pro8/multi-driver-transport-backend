export const NOTIFICATION_TYPES = [
  "order_request",
  "order_connected",
  "confirmation_request",
  "quote_request",
  "segment_rejected",
  "route_confirmed",
  "pickup_ready",
  "goods_ready",
  "payment_pickup_notified",
  "payment_delivered",
  "segment_picked_up",
  "segment_in_transit",
  "delivered",
  "zone_created",
  "general",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface UserNotificationRow {
  id: number;
  user_id: number;
  order_id: number | null;
  type: NotificationType;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Date;
}

export interface UserNotificationResponse {
  id: number;
  order_id: number | null;
  type: NotificationType;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface NotificationListResponse {
  items: UserNotificationResponse[];
  unread_count: number;
}
