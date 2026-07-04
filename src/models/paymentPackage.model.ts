export const PAYMENT_PACKAGE_TYPES = ["cheque", "cash", "money_order", "other"] as const;
export type PaymentPackageType = (typeof PAYMENT_PACKAGE_TYPES)[number];

export const MAX_PAYMENT_PACKAGES = 3;

/** PFF payment package (cheque/cash) — separate from goods `packages`. */
export interface PaymentPackageEntry {
  payment_type: PaymentPackageType;
  description: string;
  weight_lbs: number;
  package_length: number;
  package_width: number;
  package_height: number;
}

export const PAYMENT_PACKAGE_TYPE_LABELS: Record<PaymentPackageType, string> = {
  cheque: "Cheque",
  cash: "Cash",
  money_order: "Money order",
  other: "Other",
};

/** Light factor for payment parcels (cheque/cash envelope). */
export const PAYMENT_PACKAGE_FACTORS: Record<PaymentPackageType, number> = {
  cheque: 0.01,
  cash: 0.01,
  money_order: 0.01,
  other: 0.02,
};

function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isPaymentPackageType(value: unknown): value is PaymentPackageType {
  return typeof value === "string" && (PAYMENT_PACKAGE_TYPES as readonly string[]).includes(value);
}

export function defaultPaymentPackageEntry(
  type: PaymentPackageType = "cheque",
): PaymentPackageEntry {
  return {
    payment_type: type,
    description: type === "cash" ? "Cash payment" : "Payment cheque",
    weight_lbs: 0.5,
    package_length: 9,
    package_width: 4,
    package_height: 0.25,
  };
}

export function totalPaymentPackageFactor(
  packages: readonly PaymentPackageEntry[],
): number {
  return packages.reduce((sum, p) => sum + PAYMENT_PACKAGE_FACTORS[p.payment_type], 0);
}

export function formatPaymentPackageDimensions(
  entry: Pick<PaymentPackageEntry, "package_length" | "package_width" | "package_height">,
): string {
  return `${entry.package_length} × ${entry.package_width} × ${entry.package_height} in`;
}

export function normalizePaymentPackages(
  packages: Partial<PaymentPackageEntry>[] | undefined,
): PaymentPackageEntry[] {
  if (packages && packages.length > 0) {
    const parsed = packages
      .map((item) => parsePaymentPackageEntry(item))
      .filter((item): item is PaymentPackageEntry => item != null);
    if (parsed.length > 0) {
      return parsed.slice(0, MAX_PAYMENT_PACKAGES);
    }
  }
  return [defaultPaymentPackageEntry()];
}

function parsePaymentPackageEntry(item: unknown): PaymentPackageEntry | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  if (!isPaymentPackageType(row.payment_type)) return null;
  const weight_lbs = positiveNumber(row.weight_lbs);
  const package_length = positiveNumber(row.package_length);
  const package_width = positiveNumber(row.package_width);
  const package_height = positiveNumber(row.package_height);
  if (
    weight_lbs == null ||
    package_length == null ||
    package_width == null ||
    package_height == null
  ) {
    return null;
  }
  return {
    payment_type: row.payment_type,
    description: String(row.description ?? "").trim() || PAYMENT_PACKAGE_TYPE_LABELS[row.payment_type],
    weight_lbs,
    package_length,
    package_width,
    package_height,
  };
}

export function parsePaymentPackagesFromStorage(raw: unknown): PaymentPackageEntry[] {
  if (raw == null) return [defaultPaymentPackageEntry()];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [defaultPaymentPackageEntry()];
    }
  }
  if (Array.isArray(parsed)) {
    const entries = parsed
      .map((item) => parsePaymentPackageEntry(item))
      .filter((item): item is PaymentPackageEntry => item != null);
    if (entries.length > 0) return entries.slice(0, MAX_PAYMENT_PACKAGES);
  }
  return [defaultPaymentPackageEntry()];
}
