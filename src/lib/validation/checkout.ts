import { z } from "zod";

export const checkoutInitiateSchema = z.object({
  planId: z.string().min(1, "Plan ID cannot be empty."),
});

export type CheckoutInitiateInput = z.infer<typeof checkoutInitiateSchema>;

