import prisma from "@/lib/prisma";
import type { Plan, Subscription } from "@prisma/client";

export type SubscriptionWithPlan = Subscription & {
  plan: Plan;
};

/**
 * Retrieves all active subscription plans ordered by price ascending.
 */
export async function getActivePlans(): Promise<Plan[]> {
  return prisma.plan.findMany({
    where: { active: true },
    orderBy: { amountMinor: "asc" },
  });
}

/**
 * Retrieves the currently active subscription for a given user, if any.
 * Checks for status="active" and valid period end date.
 */
export async function getUserActiveSubscription(
  userId: string
): Promise<SubscriptionWithPlan | null> {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: "active",
      currentPeriodEnd: { gte: new Date() },
    },
    include: {
      plan: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return subscription;
}

/**
 * Formats minor currency units into human-readable representation.
 * (e.g. 500000 kobo -> ₦5,000)
 */
export function formatPrice(amountMinor: number, currency = "NGN"): string {
  const majorUnits = amountMinor / 100;
  if (currency.toUpperCase() === "NGN") {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(majorUnits);
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(majorUnits);
}

/**
 * Returns a user-friendly label for a plan's billing interval.
 */
export function formatIntervalLabel(interval: string): string {
  const normalized = interval.toLowerCase();
  switch (normalized) {
    case "monthly":
      return "/ month";
    case "yearly":
      return "/ year";
    case "free":
    case "none":
      return "forever";
    default:
      return `/${interval}`;
  }
}
