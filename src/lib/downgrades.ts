import prisma from "@/lib/prisma";
import { calculateSubscriptionPeriod } from "@/lib/fulfilment";
import { applyDueCancellations } from "@/lib/cancellations";
import type { Plan, Subscription, SubscriptionChange } from "@prisma/client";

export type SubscriptionWithPlan = Subscription & { plan: Plan };

export class DowngradeEligibilityError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    (err as { code?: string })?.code === "P2002" ||
    (err instanceof Error && err.message.includes("Unique constraint"))
  );
}

export interface ScheduleDowngradeResult {
  change: SubscriptionChange;
  subscription: SubscriptionWithPlan;
  fromPlan: Plan;
  toPlan: Plan;
  idempotent?: boolean;
}

/**
 * Resolves the active Monthly plan from the database.
 *
 * The client may supply a target plan id only as an assertion.
 * Pricing, interval and plan identity are always derived server-side.
 */
export async function resolveMonthlyTargetPlan(
  toPlanId?: string
): Promise<Plan> {
  const monthlyPlan = await prisma.plan.findFirst({
    where: {
      active: true,
      interval: "monthly",
    },
    orderBy: {
      amountMinor: "asc",
    },
  });

  if (!monthlyPlan) {
    throw new DowngradeEligibilityError(
      404,
      "No active Monthly plan is available for downgrade."
    );
  }

  if (toPlanId && toPlanId !== monthlyPlan.id) {
    throw new DowngradeEligibilityError(
      409,
      "Only the active Monthly plan is a valid downgrade target."
    );
  }

  return monthlyPlan;
}

/**
 * Validates that the authenticated user has an active Yearly subscription
 * and that a Monthly downgrade can be scheduled.
 */
export async function resolveDowngradeEligibility(
  userId: string,
  toPlanId?: string,
  now: Date = new Date()
): Promise<{
  subscription: SubscriptionWithPlan;
  fromPlan: Plan;
  toPlan: Plan;
}> {
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
    throw new DowngradeEligibilityError(
      409,
      "You do not have an active subscription within its billing period."
    );
  }

  const fromPlan = subscription.plan;

  if (
    fromPlan.amountMinor <= 0 ||
    fromPlan.interval.toLowerCase() !== "yearly"
  ) {
    throw new DowngradeEligibilityError(
      409,
      `Only an active Yearly subscription can be downgraded in this stage. Current plan: ${fromPlan.name}.`
    );
  }

  if (subscription.cancelAtPeriodEnd) {
    throw new DowngradeEligibilityError(
      409,
      "This subscription is already scheduled to end at the period boundary."
    );
  }

  const toPlan = await resolveMonthlyTargetPlan(toPlanId);

  if (toPlan.id === fromPlan.id) {
    throw new DowngradeEligibilityError(
      409,
      "The target plan is the same as your current plan."
    );
  }

  if (
    toPlan.currency.toUpperCase() !== fromPlan.currency.toUpperCase()
  ) {
    throw new DowngradeEligibilityError(
      409,
      "The downgrade target uses a different currency."
    );
  }

  return {
    subscription,
    fromPlan,
    toPlan,
  };
}

/**
 * Resolves an active pending downgrade for the specified subscription.
 */
export async function getPendingDowngrade(
  subscriptionId: string
): Promise<(SubscriptionChange & { toPlan: Plan }) | null> {
  return prisma.subscriptionChange.findFirst({
    where: {
      subscriptionId,
      changeType: "downgrade",
      status: "pending",
    },
    include: {
      toPlan: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

/**
 * Schedules Yearly → Monthly for the end of the current Yearly period.
 *
 * No payment is taken now and the Subscription remains Yearly until
 * currentPeriodEnd.
 */
export async function scheduleDowngrade(options: {
  userId: string;
  toPlanId?: string;
  now?: Date;
}): Promise<ScheduleDowngradeResult> {
  const { userId, toPlanId, now = new Date() } = options;

  const { subscription, fromPlan, toPlan } =
    await resolveDowngradeEligibility(userId, toPlanId, now);

  return await prisma.$transaction(async (tx) => {
    // If a pending downgrade already exists for this subscription and
    // target plan, return it rather than creating another change.
    const existingChange = await tx.subscriptionChange.findFirst({
      where: {
        subscriptionId: subscription.id,
        changeType: "downgrade",
        status: "pending",
      },
      include: {
        fromPlan: true,
        toPlan: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingChange) {
      if (existingChange.toPlanId !== toPlan.id) {
        throw new DowngradeEligibilityError(
          409,
          "A different subscription change is already pending for this subscription."
        );
      }

      return {
        change: existingChange,
        subscription,
        fromPlan,
        toPlan,
        idempotent: true,
      };
    }

    try {
      const change = await tx.subscriptionChange.create({
        data: {
          subscriptionId: subscription.id,
          fromPlanId: fromPlan.id,
          toPlanId: toPlan.id,
          changeType: "downgrade",
          effectiveAt: subscription.currentPeriodEnd,
          daysRemaining: Math.max(
            0,
            Math.ceil(
              (subscription.currentPeriodEnd.getTime() - now.getTime()) /
                (1000 * 60 * 60 * 24)
            )
          ),
          oldPeriodAmountMinor: fromPlan.amountMinor,
          newPeriodAmountMinor: toPlan.amountMinor,
          creditMinor: 0,
          chargeMinor: 0,
          currency: toPlan.currency,
          status: "pending",
        },
      });

      return {
        change,
        subscription,
        fromPlan,
        toPlan,
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const concurrentChange = await tx.subscriptionChange.findFirst({
          where: {
            subscriptionId: subscription.id,
            changeType: "downgrade",
            status: "pending",
          },
          include: {
            fromPlan: true,
            toPlan: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        if (concurrentChange) {
          return {
            change: concurrentChange,
            subscription,
            fromPlan,
            toPlan,
            idempotent: true,
          };
        }
      }

      throw error;
    }
  });
}

/**
 * Applies all due pending subscription changes.
 *
 * This function is intended to be called by a trusted server-side
 * scheduler/cron endpoint.
 *
 * A downgrade changes the plan only after the existing billing period
 * has ended. No Paystack transaction is created.
 */
export async function applyDueSubscriptionChanges(
  now: Date = new Date()
): Promise<{
  applied: number;
  skipped: number;
  errors: Array<{ changeId: string; error: string }>;
}> {
  const dueChanges = await prisma.subscriptionChange.findMany({
    where: {
      status: "pending",
      effectiveAt: {
        lte: now,
      },
      changeType: "downgrade",
    },
    include: {
      subscription: true,
      fromPlan: true,
      toPlan: true,
    },
    orderBy: {
      effectiveAt: "asc",
    },
  });

  let applied = 0;
  let skipped = 0;
  const errors: Array<{ changeId: string; error: string }> = [];

  for (const change of dueChanges) {
    try {
      const subscription = change.subscription;

      // The subscription may have been changed by another request,
      // marked to cancel at period end, or cancelled by another run.
      if (
        subscription.status !== "active" ||
        subscription.planId !== change.fromPlanId ||
        subscription.cancelAtPeriodEnd
      ) {
        await prisma.subscriptionChange.updateMany({
          where: {
            id: change.id,
            status: "pending",
          },
          data: {
            status: "cancelled",
          },
        });

        skipped++;
        continue;
      }

      // The scheduled downgrade must not apply before the existing
      // billing period has actually ended.
      if (subscription.currentPeriodEnd > now) {
        skipped++;
        continue;
      }

      const newPeriod = calculateSubscriptionPeriod(
        subscription.currentPeriodEnd,
        change.toPlan.interval
      );

      const updated = await prisma.subscription.updateMany({
        where: {
          id: subscription.id,
          status: "active",
          planId: change.fromPlanId,
          currentPeriodEnd: {
            lte: now,
          },
        },
        data: {
          planId: change.toPlanId,
          amountMinor: change.toPlan.amountMinor,
          currency: change.toPlan.currency,
          currentPeriodStart: newPeriod.currentPeriodStart,
          currentPeriodEnd: newPeriod.currentPeriodEnd,
        },
      });

      if (updated.count === 0) {
        skipped++;
        continue;
      }

      await prisma.subscriptionChange.updateMany({
        where: {
          id: change.id,
          status: "pending",
        },
        data: {
          status: "applied",
          effectiveAt: subscription.currentPeriodEnd,
        },
      });

      applied++;
    } catch (error) {
      errors.push({
        changeId: change.id,
        error:
          error instanceof Error
            ? error.message
            : "Failed to apply subscription change.",
      });
    }
  }

  // Process any subscriptions reaching period end with cancellation scheduled
  await applyDueCancellations(now);

  return {
    applied,
    skipped,
    errors,
  };
}