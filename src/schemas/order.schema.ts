import { z } from "zod";
import { latitudeSchema, longitudeSchema } from "./h3.schema";
import {
  MAX_PACKAGES,
  PACKAGE_TYPES,
  normalizeOrderPackages,
} from "../models/package.model";
import {
  MAX_PAYMENT_PACKAGES,
  PAYMENT_PACKAGE_TYPES,
  normalizePaymentPackages,
} from "../models/paymentPackage.model";
import { isPffPaymentMethod } from "../utils/paymentFlow";

export const packageTypeSchema = z.enum(PACKAGE_TYPES);

const positivePackageNumber = (label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a number` })
    .positive(`${label} must be greater than 0`)
    .max(1_000_000);

export const orderPackageEntrySchema = z.object({
  package_type: packageTypeSchema,
  weight_lbs: positivePackageNumber("weight_lbs"),
  package_length: positivePackageNumber("package_length"),
  package_width: positivePackageNumber("package_width"),
  package_height: positivePackageNumber("package_height"),
});

function resolvePackagesInput(data: {
  packages?: z.infer<typeof orderPackageEntrySchema>[];
  package_type?: z.infer<typeof packageTypeSchema>;
  weight_lbs?: number | null;
  package_length?: number | null;
  package_width?: number | null;
  package_height?: number | null;
}) {
  return normalizeOrderPackages(data.packages, data.package_type ?? null, {
    weight_lbs: data.weight_lbs,
    package_length: data.package_length,
    package_width: data.package_width,
    package_height: data.package_height,
  });
}

export const paymentPackageEntrySchema = z.object({
  payment_type: z.enum(PAYMENT_PACKAGE_TYPES),
  description: z.string().trim().max(300).optional().default(""),
  weight_lbs: positivePackageNumber("weight_lbs"),
  package_length: positivePackageNumber("package_length"),
  package_width: positivePackageNumber("package_width"),
  package_height: positivePackageNumber("package_height"),
});

export const createReceiverOrderSchema = z.object({
  sender_user_id: z.number().int().positive(),
  destination_address: z.string().trim().min(1).max(300),
  destination_lat: latitudeSchema,
  destination_lng: longitudeSchema,
  receiver_billing_address: z.string().trim().max(300).optional().default(""),
  notes: z.string().trim().max(1000).optional().default(""),
  payment_method: z.string().trim().max(60).optional().default(""),
  shipping_method: z.string().trim().max(60).optional().default(""),
  package_description: z.string().trim().max(1000).optional().default(""),
  package_type: packageTypeSchema.optional(),
  packages: z.array(orderPackageEntrySchema).min(1).max(MAX_PACKAGES).optional(),
  payment_packages: z
    .array(paymentPackageEntrySchema)
    .min(1)
    .max(MAX_PAYMENT_PACKAGES)
    .optional(),
  weight_lbs: positivePackageNumber("weight_lbs").optional().nullable(),
  package_length: positivePackageNumber("package_length").optional().nullable(),
  package_width: positivePackageNumber("package_width").optional().nullable(),
  package_height: positivePackageNumber("package_height").optional().nullable(),
  dimensions: z.string().trim().max(500).optional().default(""),
}).superRefine((data, ctx) => {
  const packages = resolvePackagesInput(data);
  if (packages.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["packages"],
      message: "Provide at least one package with type, weight, and dimensions",
    });
  }
  if (isPffPaymentMethod(data.payment_method)) {
    const paymentPackages = normalizePaymentPackages(data.payment_packages);
    if (paymentPackages.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payment_packages"],
        message: "PFF orders require at least one payment package (cheque/cash)",
      });
    }
  }
});

export const createOrderSchema = z.object({
  receiver_user_id: z.number().int().positive(),
  sender_address: z.string().trim().max(300).optional().default(""),
  sender_billing_address: z.string().trim().max(300).optional().default(""),
  sender_lat: latitudeSchema.optional().nullable(),
  sender_lng: longitudeSchema.optional().nullable(),
  destination_address: z.string().trim().max(300).optional(),
  destination_lat: latitudeSchema.optional().nullable(),
  destination_lng: longitudeSchema.optional().nullable(),
  receiver_billing_address: z.string().trim().max(300).optional().default(""),
  notes: z.string().trim().max(1000).optional().default(""),
  driver_user_id: z.number().int().positive().optional().nullable(),
  source_name: z.string().trim().max(200).optional().default(""),
  source_contact: z.string().trim().max(120).optional().default(""),
  payment_method: z.string().trim().max(60).optional().default(""),
  shipping_method: z.string().trim().max(60).optional().default(""),
  package_description: z.string().trim().max(1000).optional().default(""),
  /** @deprecated Use `packages` — kept for single-package clients. */
  package_type: packageTypeSchema.optional(),
  packages: z.array(orderPackageEntrySchema).min(1).max(MAX_PACKAGES).optional(),
  /** @deprecated Applied to a single package when `packages` is omitted. */
  weight_lbs: positivePackageNumber("weight_lbs").optional().nullable(),
  package_weight_unit: z.literal("lb").optional().default("lb"),
  package_length: positivePackageNumber("package_length").optional().nullable(),
  package_width: positivePackageNumber("package_width").optional().nullable(),
  package_height: positivePackageNumber("package_height").optional().nullable(),
  package_dimension_unit: z.literal("in").optional().default("in"),
  dimensions: z.string().trim().max(500).optional().default(""),
}).superRefine((data, ctx) => {
  const packages = resolvePackagesInput(data);
  if (packages.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["packages"],
      message: "Provide at least one package with type, weight, and dimensions",
    });
    return;
  }

  if (!data.packages?.length) {
    const missing =
      data.weight_lbs == null ||
      data.package_length == null ||
      data.package_width == null ||
      data.package_height == null;
    if (missing && !data.package_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packages"],
        message: "Provide packages array or package_type with weight and dimensions",
      });
    }
  }

  if (data.package_weight_unit && data.package_weight_unit !== "lb") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["package_weight_unit"],
      message: "Weight unit must be lb (pounds)",
    });
  }
  if (data.package_dimension_unit && data.package_dimension_unit !== "in") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["package_dimension_unit"],
      message: "Dimension unit must be in (inches)",
    });
  }
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["delivering", "received"]),
});

export const updateOrderPackageSchema = z
  .object({
    package_type: packageTypeSchema.optional(),
    packages: z.array(orderPackageEntrySchema).min(1).max(MAX_PACKAGES).optional(),
    weight_lbs: positivePackageNumber("weight_lbs").optional().nullable(),
    package_length: positivePackageNumber("package_length").optional().nullable(),
    package_width: positivePackageNumber("package_width").optional().nullable(),
    package_height: positivePackageNumber("package_height").optional().nullable(),
    package_description: z.string().trim().max(1000).optional(),
    dimensions: z.string().trim().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    const hasField =
      data.package_type != null ||
      (data.packages != null && data.packages.length > 0) ||
      data.weight_lbs !== undefined ||
      data.package_length !== undefined ||
      data.package_width !== undefined ||
      data.package_height !== undefined ||
      data.package_description !== undefined ||
      data.dimensions !== undefined;
    if (!hasField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one package field to update",
      });
    }
  });

export type CreateReceiverOrderRequest = z.infer<typeof createReceiverOrderSchema>;
export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusSchema>;
export type UpdateOrderPackageRequest = z.infer<typeof updateOrderPackageSchema>;
