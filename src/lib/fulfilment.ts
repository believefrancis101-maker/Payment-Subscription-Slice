import prisma from "@/lib/prisma";
import type { Subscription, Plan } from "@prisma/client";

export interface FulfilmentResult {
  success: boolean;
  idempotent?: boolean;
  conflict?: boolean;
  error?: string;
  subscription?: Subscription & { plan: Plan };
}

export interface FulfilmentOptions {
  provider?: string;
  providerReference: string;
}

/**
 * Calculates exact subscription start and end dates.
 * - Monthly: currentPeriodStart + 1 calendar month
/**
 * Deterministic calendar period calculation without month/year overflow.
 *
 * Rules:
 * - Monthly: adds 1 calendar month. If the target month has fewer days than the start day,
 *   clamps to the last valid day of that month (e.g. Jan 31 -> Feb 28/29, Aug 31 -> Sep 30).
 * - Yearly: adds 1 calendar year. If start is Feb 29 and next year is not a leap year,
 *   clamps to Feb 28.
 * - Normal dates retain their calendar day where that day exists.
 * - Uses UTC methods to ensure timezone stability and prevent DST drift.
 */
export function calculateSubscriptionPeriod(
  startDate: Date,
  interval: string
): { currentPeriodStart: Date; currentPeriodEnd: Date } {
  const currentPeriodStart = new Date(startDate.getTime());
  const normalized = interval.trim().toLowerCase();

  const startYear = currentPeriodStart.getUTCFullYear();
  const startMonth = currentPeriodStart.getUTCMonth();
  const startDay = currentPeriodStart.getUTCDate();
  const startHours = currentPeriodStart.getUTCHours();
  const startMinutes = currentPeriodStart.getUTCMinutes();
  const startSeconds = currentPeriodStart.getUTCSeconds();
  const startMs = currentPeriodStart.getUTCMilliseconds();

  let targetYear: number;
  let targetMonth: number;

  if (normalized === "monthly") {
    if (startMonth === 11) {
      targetYear = startYear + 1;
      targetMonth = 0;
    } else {
      targetYear = startYear;
      targetMonth = startMonth + 1;
    }
  } else if (normalized === "yearly") {
    targetYear = startYear + 1;
    targetMonth = startMonth;
  } else {
    throw new Error(
      `Unsupported subscription interval for fulfilment: '${interval}'. Only 'monthly' and 'yearly' are supported.`
    );
  }

  // Determine maximum valid days in target month for target year
  const maxDaysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();

  // Clamp calendar day if necessary (e.g. Jan 31 -> Feb 28/29, Aug 31 -> Sep 30, Feb 29 -> Feb 28)
  const targetDay = Math.min(startDay, maxDaysInTargetMonth);

  const currentPeriodEnd = new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      targetDay,
      startHours,
      startMinutes,
      startSeconds,
      startMs
    )
  );

  return { currentPeriodStart, currentPeriodEnd };
}

/**
 * Server-side Subscription Fulfilment Service.
 * 
 * Safely converts verified payment evidence into a single active Subscription record
 * and logs an immutable 'payment.fulfilled' audit event.
 * 
 * Enforces:
 * 1. Matching checkout.initiated event.
 * 2. Matching payment.verified event with status = "verified".
 * 3. Exact plan resolution and amount/currency match.
 * 4. Database-enforced idempotency via originatingPaymentReference and PaymentEvent unique index.
 * 5. Protection of existing active paid subscriptions (no overwrites or unhandled upgrades).
 * 6. Linking verified payment event to created subscription.
 */
export async function fulfilSubscription(
  options: FulfilmentOptions
): Promise<FulfilmentResult> {
  const { provider = "paystack", providerReference } = options;

  if (!providerReference || typeof providerReference !== "string") {
    return { success: false, error: "Invalid provider reference." };
  }

  // 1. Check for existing subscription by originating payment reference (Idempotency check)
  const existingSubscription = await prisma.subscription.findUnique({
    where: { originatingPaymentReference: providerReference },
    include: { plan: true },
  });

  if (existingSubscription) {
    return {
      success: true,
      idempotent: true,
      subscription: existingSubscription,
    };
  }

  // 2. Find matching checkout.initiated event
  const initiatedEvent = await prisma.paymentEvent.findFirst({
    where: {
      provider,
      providerReference,
      eventType: "checkout.initiated",
    },
  });

  if (!initiatedEvent) {
    return {
      success: false,
      error: `No checkout initiation record found for reference '${providerReference}'.`,
    };
  }

  // 3. Confirm matching payment.verified event with status = "verified"
  const verifiedEvent = await prisma.paymentEvent.findUnique({
    where: {
      provider_providerReference_eventType: {
        provider,
        providerReference,
        eventType: "payment.verified",
      },
    },
  });

  if (!verifiedEvent || verifiedEvent.status !== "verified") {
    return {
      success: false,
      error: `Cannot fulfil payment: Valid verified payment event not found for reference '${providerReference}'.`,
    };
  }

  // 4. Resolve purchased plan from checkout/payment data
  let targetPlanId = "";
  if (initiatedEvent.payload) {
    try {
      const parsed = JSON.parse(initiatedEvent.payload);
      targetPlanId = parsed.planId;
    } catch {
      // Ignore JSON parse error
    }
  }

  if (!targetPlanId && verifiedEvent.payload) {
    try {
      const parsed = JSON.parse(verifiedEvent.payload);
      targetPlanId = parsed.planId;
    } catch {
      // Ignore JSON parse error
    }
  }

  const plan = await prisma.plan.findUnique({
    where: { id: targetPlanId },
  });

  if (!plan) {
    return {
      success: false,
      error: `Plan associated with transaction reference '${providerReference}' not found.`,
    };
  }

  // Free plans cannot be fulfilled as paid subscriptions
  if (plan.name.toLowerCase() === "free" || plan.amountMinor <= 0) {
    return {
      success: false,
      error: "Free plan does not require paid subscription fulfilment.",
    };
  }

  // 5. Confirm verified payment amount and currency match the plan
  if (
    verifiedEvent.amountMinor !== plan.amountMinor ||
    verifiedEvent.currency.toUpperCase() !== plan.currency.toUpperCase()
  ) {
    return {
      success: false,
      error: `Verified payment amount (${verifiedEvent.amountMinor} ${verifiedEvent.currency}) does not match plan requirements (${plan.amountMinor} ${plan.currency}).`,
    };
  }

  // 6. Protect existing active subscriptions (Stage 4 constraint: No upgrades/replacements)
  const now = new Date();
  const existingActiveSub = await prisma.subscription.findFirst({
    where: {
      userId: initiatedEvent.userId,
      status: "active",
      currentPeriodEnd: { gte: now },
    },
    include: { plan: true },
  });

  if (existingActiveSub) {
    if (existingActiveSub.originatingPaymentReference === providerReference) {
      return {
        success: true,
        idempotent: true,
        subscription: existingActiveSub,
      };
    }

    return {
      success: false,
      conflict: true,
      error:
        "User already has an active subscription. Subscription changes and upgrades are not supported at this stage.",
    };
  }

  // 7. Calculate Subscription Period Dates
  const { currentPeriodStart, currentPeriodEnd } = calculateSubscriptionPeriod(
    now,
    plan.interval
  );

  // Extract customer code if available
  let providerCustomerCode: string | null = null;
  if (verifiedEvent.payload) {
    try {
      const parsed = JSON.parse(verifiedEvent.payload);
      providerCustomerCode = parsed.customerCode || null;
    } catch {
      // Ignore JSON parse error
    }
  }

  // 8. Execute Atomic Fulfilment with P2002 Concurrency Protection
  try {
    // Create exactly one Subscription (enforced by @unique originatingPaymentReference)
    const createdSub = await prisma.subscription.create({
      data: {
        userId: initiatedEvent.userId,
        planId: plan.id,
        status: "active",
        currency: plan.currency,
        amountMinor: plan.amountMinor,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        cancellationReason: null,
        originatingPaymentReference: providerReference,
        providerCustomerCode,
      },
      include: {
        plan: true,
      },
    });

    // Record immutable payment.fulfilled event (enforced by @@unique providerReference + eventType)
    await prisma.paymentEvent.create({
      data: {
        userId: initiatedEvent.userId,
        subscriptionId: createdSub.id,
        provider,
        providerReference,
        eventType: "payment.fulfilled",
        status: "fulfilled",
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        processedAt: now,
        payload: JSON.stringify({
          subscriptionId: createdSub.id,
          planId: plan.id,
          planName: plan.name,
          interval: plan.interval,
          currentPeriodStart: currentPeriodStart.toISOString(),
          currentPeriodEnd: currentPeriodEnd.toISOString(),
        }),
      },
    });

    return {
      success: true,
      subscription: createdSub,
    };
  } catch (err: unknown) {
    const isUniqueConstraint =
      (err as { code?: string })?.code === "P2002" ||
      (err instanceof Error && err.message.includes("Unique constraint"));

    if (isUniqueConstraint) {
      // Concurrent execution won the race; look up the committed subscription
      const concurrentSub = await prisma.subscription.findUnique({
        where: { originatingPaymentReference: providerReference },
        include: { plan: true },
      });

      if (concurrentSub) {
        return {
          success: true,
          idempotent: true,
          subscription: concurrentSub,
        };
      }
    }

    console.error("Subscription fulfilment error:", err);
    return {
      success: false,
      error:
        err instanceof Error ? err.message : "Failed to fulfil subscription.",
    };
  }
}
