import { z } from "zod";

export const checkoutInitiateSchema = z.object({
  planId: z.string().min(1, "Plan ID cannot be empty."),
});

export const checkoutVerifySchema = z.object({
  reference: z.string().min(1, "Transaction reference cannot be empty."),
});

export type CheckoutVerifyInput = z.infer<typeof checkoutVerifySchema>;

export const upgradeQuoteSchema = z.object({
  toPlanId: z.string().min(1, "Target plan ID cannot be empty.").optional(),
});

export type UpgradeQuoteInput = z.infer<typeof upgradeQuoteSchema>;

export const upgradeInitiateSchema = z.object({
  toPlanId: z.string().min(1, "Target plan ID cannot be empty.").optional(),
});

export type UpgradeInitiateInput = z.infer<typeof upgradeInitiateSchema>;


