/** System-wide unit standards enforced by the pricing engine. */
export const PRICING_UNITS = {
  weight: "lb",
  dimension: "in",
  distance: "km",
  time: "hr",
} as const;

/** Default booking fee applied to segment sub-totals (2%). */
export const DEFAULT_BOOKING_FEE_RATE = 0.02;

/** Fallback land speed (km/h) when estimating transit time without a schedule. */
export const DEFAULT_LAND_SPEED_KMH = 50;

/** Fallback sea speed (km/h) when estimating maritime transit time (~20 kn). */
export const DEFAULT_SEA_SPEED_KMH = 37;
