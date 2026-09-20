import prisma from "@/lib/prisma";
import type { Plan, Subscription } from "@prisma/client";

export type SubscriptionWithPlan = Subscription & { plan: Plan };

export class CancellationEligibilityError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ScheduleCancellationResult {
  subscription: SubscriptionWithPlan;
  idempotent: boolean;
}

/**
 * Schedules the cancellation of an active paid subscription at the end of its current billing period.
 *
 * Rules:
 * 1. Subscription remains active with its current plan until currentPeriodEnd.
 * 2. cancelAtPeriodEnd is set to true.
 * 3. cancelledAt records the cancellation timestamp.
 * 4. cancellationReason is stored if provided.
 * 5. If a pending downgrade (Stage 6) exists on this subscription, it is cancelled so it won't
 *    unexpectedly switch after the subscription expires.
 * 6. Idempotent: If cancellation is already scheduled, returns the existing subscription with idempotent: true.
 * 7. Rejects if no active subscription exists or if it's the free plan.
 */
export async function scheduleCancellation(
  userId: string,
  reason?: string,
  now: Date = new Date()
): Promise<ScheduleCancellationResult> {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: "active",
      currentPeriodStart: { lte: now },
      currentPeriodEnd: { gte: now },
    },
    include: {
      plan: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!subscription) {
    throw new CancellationEligibilityError(
      404,
      "No active subscription found to cancel."
    );
  }

  if (subscription.plan.amountMinor <= 0) {
    throw new CancellationEligibilityError(
      400,
      "Free subscriptions cannot be cancelled."
    );
  }

  // Fast-path idempotency check
  if (subscription.cancelAtPeriodEnd) {
    return {
      subscription,
      idempotent: true,
    };
  }

  return await prisma.$transaction(async (tx) => {
    // Re-verify under transaction lock to prevent race conditions
    const currentSub = await tx.subscription.findUnique({
      where: { id: subscription.id },
      include: { plan: true },
    });

    if (!currentSub || currentSub.status !== "active") {
      throw new CancellationEligibilityError(
        409,
        "Subscription is no longer active."
      );
    }

    if (currentSub.cancelAtPeriodEnd) {
      return {
        subscription: currentSub,
        idempotent: true,
      };
    }

    // Stage 6 interaction: Cancellation wins over pending downgrade.
    // Invalidate any pending SubscriptionChanges for this subscription so it does
    // not switch to another plan at period end.
    await tx.subscriptionChange.updateMany({
      where: {
        subscriptionId: currentSub.id,
        status: "pending",
      },
      data: {
        status: "cancelled",
      },
    });

    const updatedSubscription = await tx.subscription.update({
      where: { id: currentSub.id },
      data: {
        cancelAtPeriodEnd: true,
        cancelledAt: now,
        cancellationReason: reason?.trim() ? reason.trim() : null,
      },
      include: {
        plan: true,
      },
    });

    return {
      subscription: updatedSubscription,
      idempotent: false,
    };
  });
}

/**
 * Applies all due cancellations for subscriptions that have reached or passed currentPeriodEnd.
 * Transitions their status from "active" to "cancelled".
 */
export async function applyDueCancellations(
  now: Date = new Date()
): Promise<{ applied: number; count: number }> {
  const dueSubscriptions = await prisma.subscription.findMany({
    where: {
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: {
        lte: now,
      },
    },
  });

  let applied = 0;

  for (const sub of dueSubscriptions) {
    await prisma.$transaction(async (tx) => {
      // Invalidate any leftover pending changes
      await tx.subscriptionChange.updateMany({
        where: {
          subscriptionId: sub.id,
          status: "pending",
        },
        data: {
          status: "cancelled",
        },
      });

      // Transition to terminal cancelled status
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: "cancelled",
        },
      });
    });

    applied++;
  }

  return { applied, count: dueSubscriptions.length };
}
