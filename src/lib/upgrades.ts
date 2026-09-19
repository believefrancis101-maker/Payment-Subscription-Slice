import crypto from "crypto";
import prisma from "@/lib/prisma";
import { calculateSubscriptionPeriod, fulfilSubscription } from "@/lib/fulfilment";
import {
  generateCheckoutReference,
  initializePaystackTransaction,
} from "@/lib/paystack";
import { calculateUpgradeProration, type UpgradeProrationResult } from "@/lib/proration";
import type { Plan, Subscription, SubscriptionChange, PaymentEvent } from "@prisma/client";

export type SubscriptionWithPlan = Subscription & { plan: Plan };
export type SubscriptionChangeWithRelations = SubscriptionChange & {
  subscription: SubscriptionWithPlan;
  fromPlan: Plan;
  toPlan: Plan;
};

export interface FulfilmentResult {
  success: boolean;
  idempotent?: boolean;
  conflict?: boolean;
  error?: string;
  subscription?: Subscription & { plan: Plan };
}

export class UpgradeEligibilityError extends Error {
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

function parsePayload<T>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

interface InitiatedUpgradePayload {
  changeType?: string;
  changeId?: string;
  planId?: string;
}

/**
 * Resolves the active Yearly plan from the database. The target plan is
 * fully server-controlled: a client-supplied target id is treated only as
 * an assertion and must equal the active Yearly plan, otherwise the
 * request is rejected. There is exactly one supported Stage 5 transition:
 * Monthly → Yearly.
 */
export async function resolveYearlyTargetPlan(toPlanId?: string): Promise<Plan> {
  const activeYearly = await prisma.plan.findFirst({
    where: { active: true, interval: "yearly" },
  });

  if (!activeYearly) {
    throw new UpgradeEligibilityError(
      404,
      "No active Yearly plan is available for upgrade."
    );
  }

  if (toPlanId && toPlanId !== activeYearly.id) {
    throw new UpgradeEligibilityError(
      409,
      "Only the active Yearly plan is a valid upgrade target."
    );
  }

  return activeYearly;
}

/**
 * Server-side eligibility guard for the Monthly → Yearly upgrade.
 *
 * Never trusts client-supplied amounts or subscription state: the active
 * subscription, the current plan, and the target plan are all re-derived
 * from the database for the authenticated user.
 */
export async function resolveUpgradeEligibility(
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
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    throw new UpgradeEligibilityError(
      409,
      "You do not have an active subscription within its billing period to upgrade."
    );
  }

  const fromPlan = subscription.plan;

  if (fromPlan.amountMinor <= 0 || fromPlan.interval.toLowerCase() !== "monthly") {
    throw new UpgradeEligibilityError(
      409,
      `Only an active Monthly subscription can be upgraded in this stage. Current plan: ${fromPlan.name}.`
    );
  }

  if (subscription.cancelAtPeriodEnd) {
    throw new UpgradeEligibilityError(
      409,
      "This subscription is scheduled to cancel at the end of the period. Upgrade is not available while cancellation is pending."
    );
  }

  const toPlan = await resolveYearlyTargetPlan(toPlanId);

  if (toPlan.id === fromPlan.id) {
    throw new UpgradeEligibilityError(
      409,
      "The target plan is the same as your current plan."
    );
  }

  return { subscription, fromPlan, toPlan };
}

export interface UpgradeQuote {
  currentPlan: {
    id: string;
    name: string;
    interval: string;
    amountMinor: number;
    currency: string;
  };
  targetPlan: {
    id: string;
    name: string;
    interval: string;
    amountMinor: number;
    currency: string;
  };
  quoteId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  proration: UpgradeProrationResult;
}

/**
 * Read-only proration preview. Derives every figure server-side and
 * persists nothing: loading a quote never creates a change or a payment.
 */
export async function getUpgradeQuote(
  userId: string,
  toPlanId?: string,
  now: Date = new Date()
): Promise<UpgradeQuote> {
  const { subscription, fromPlan, toPlan } = await resolveUpgradeEligibility(
    userId,
    toPlanId,
    now
  );

  const proration = calculateUpgradeProration({
    oldPeriodAmountMinor: fromPlan.amountMinor,
    newPeriodAmountMinor: toPlan.amountMinor,
    currency: toPlan.currency,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    now,
  });

  return {
    currentPlan: {
      id: fromPlan.id,
      name: fromPlan.name,
      interval: fromPlan.interval,
      amountMinor: fromPlan.amountMinor,
      currency: fromPlan.currency,
    },
    targetPlan: {
      id: toPlan.id,
      name: toPlan.name,
      interval: toPlan.interval,
      amountMinor: toPlan.amountMinor,
      currency: toPlan.currency,
    },
    quoteId: crypto.randomUUID(),
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    proration,
  };
}

export interface InitiateUpgradeResult {
  /** "created" = this request created the attempt; "existing" = converged on an earlier attempt */
  kind: "created" | "existing";
  authorizationUrl: string;
  reference: string;
  accessCode: string | null;
  changeId: string;
  subscriptionId: string;
  fromPlan: Plan;
  toPlan: Plan;
  proration: UpgradeProrationResult;
}

export interface InitiateUpgradeOptions {
  userId: string;
  email: string;
  /** Optional assertion only: must equal the active Yearly plan. */
  toPlanId?: string;
  now?: Date;
}

interface InitiatedCheckoutPayload {
  changeId?: string;
  authorizationUrl?: string;
  currentPeriodDays?: number;
}

async function loadExistingAttempt(
  subscriptionId: string,
  reference: string
): Promise<{
  change: SubscriptionChange & { fromPlan: Plan; toPlan: Plan };
  event: PaymentEvent;
  payload: InitiatedCheckoutPayload;
} | null> {
  const event = await prisma.paymentEvent.findFirst({
    where: { subscriptionId, providerReference: reference, eventType: "checkout.initiated" },
  });
  if (!event) return null;

  const payload = parsePayload<InitiatedCheckoutPayload>(event.payload) ?? {};
  if (!payload.changeId) return null;

  const change = await prisma.subscriptionChange.findUnique({
    where: { id: payload.changeId },
    include: { fromPlan: true, toPlan: true },
  });
  if (!change || change.status !== "pending" || change.subscriptionId !== subscriptionId) {
    return null;
  }

  return { change, event, payload };
}

function existingUpgradeResult(
  attempt: NonNullable<Awaited<ReturnType<typeof loadExistingAttempt>>>,
  subscriptionId: string
): InitiateUpgradeResult {
  const { change, event, payload } = attempt;
  const proration: UpgradeProrationResult = {
    currentPeriodDays: payload.currentPeriodDays ?? 0,
    daysRemaining: change.daysRemaining ?? 0,
    oldPeriodAmountMinor: change.oldPeriodAmountMinor ?? 0,
    newPeriodAmountMinor: change.newPeriodAmountMinor ?? 0,
    creditMinor: change.creditMinor ?? 0,
    chargeMinor: change.chargeMinor ?? 0,
    currency: change.currency,
  };
  return {
    kind: "existing",
    authorizationUrl: payload.authorizationUrl ?? "",
    reference: event.providerReference,
    accessCode: null,
    changeId: change.id,
    subscriptionId,
    fromPlan: change.fromPlan,
    toPlan: change.toPlan,
    proration,
  };
}

/**
 * Initiates the Monthly → Yearly upgrade checkout exactly once per pending
 * attempt. The active Yearly plan is resolved server-side; client-supplied
 * amounts are never trusted.
 *
 * Concurrency guarantee: before any Paystack initialization the subscription
 * row is claimed via a DB-atomic conditional update
 * (where pendingUpgradeReference IS NULL). Only the winning request creates a
 * Paystack reference and a pending SubscriptionChange; concurrent requests
 * either converge on the same attempt (same reference, same authorization
 * URL) or are rejected with a clear 409. A second Paystack reference can
 * therefore never be created for the same pending upgrade.
 */
export async function initiateUpgradeCheckout(
  options: InitiateUpgradeOptions
): Promise<InitiateUpgradeResult> {
  const { userId, email, toPlanId, now = new Date() } = options;

  const { subscription, fromPlan, toPlan } = await resolveUpgradeEligibility(
    userId,
    toPlanId,
    now
  );

  const proration = calculateUpgradeProration({
    oldPeriodAmountMinor: fromPlan.amountMinor,
    newPeriodAmountMinor: toPlan.amountMinor,
    currency: toPlan.currency,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    now,
  });

  // 1. Fast path: an earlier initiate already owns this subscription's
  //    pending upgrade → converge on it, reusing its exact Paystack link.
  if (subscription.pendingUpgradeReference) {
    const existingRef = subscription.pendingUpgradeReference;
    const existing = await loadExistingAttempt(subscription.id, existingRef);
    if (existing) {
      return existingUpgradeResult(existing, subscription.id);
    }
    throw new UpgradeEligibilityError(
      409,
      "An upgrade checkout is already being initiated for this subscription. Please retry shortly."
    );
  }

  // 2. Claim the subscription. updateMany is atomic in the database: under
  //    concurrency exactly one request observes count === 1.
  const reference = generateCheckoutReference("pstk-upg");
  const claimed = await prisma.subscription.updateMany({
    where: { id: subscription.id, pendingUpgradeReference: null },
    data: { pendingUpgradeReference: reference },
  });

  if (claimed.count === 0) {
    const winner = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    const winnerRef = winner?.pendingUpgradeReference;
    if (winnerRef) {
      const existing = await loadExistingAttempt(subscription.id, winnerRef);
      if (existing) {
        return existingUpgradeResult(existing, subscription.id);
      }
    }
    throw new UpgradeEligibilityError(
      409,
      "An upgrade checkout is already being initiated for this subscription. Please retry shortly."
    );
  }

  // 3. Persist the pending change, then create a ONE-TIME Paystack
  //    transaction for the exact prorated charge. No Paystack `plan` /
  //    `plan_code` is sent, so Paystack can never substitute its configured
  //    plan amount for our charge.
  let change: SubscriptionChange | null = null;
  let paystackInitialized = false;
  let paystackAuthorizationUrl: string | null = null;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const callbackUrl = `${appUrl}/plans?checkout_status=completed&reference=${encodeURIComponent(
    reference
  )}`;

  const persistInitiatedEvidence = () =>
    prisma.paymentEvent.create({
      data: {
        userId,
        subscriptionId: subscription.id,
        provider: "paystack",
        providerReference: reference,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: proration.chargeMinor,
        currency: proration.currency,
        payload: JSON.stringify({
          changeType: "upgrade",
          changeId: change?.id,
          subscriptionId: subscription.id,
          planId: toPlan.id,
          planName: toPlan.name,
          interval: toPlan.interval,
          fromPlanId: fromPlan.id,
          toPlanId: toPlan.id,
          currentPeriodDays: proration.currentPeriodDays,
          daysRemaining: proration.daysRemaining,
          oldPeriodAmountMinor: proration.oldPeriodAmountMinor,
          newPeriodAmountMinor: proration.newPeriodAmountMinor,
          creditMinor: proration.creditMinor,
          chargeMinor: proration.chargeMinor,
          authorizationUrl: paystackAuthorizationUrl ?? "",
        }),
      },
    });

  try {
    change = await prisma.subscriptionChange.create({
      data: {
        subscriptionId: subscription.id,
        fromPlanId: fromPlan.id,
        toPlanId: toPlan.id,
        changeType: "upgrade",
        effectiveAt: now,
        daysRemaining: proration.daysRemaining,
        oldPeriodAmountMinor: proration.oldPeriodAmountMinor,
        newPeriodAmountMinor: proration.newPeriodAmountMinor,
        creditMinor: proration.creditMinor,
        chargeMinor: proration.chargeMinor,
        currency: proration.currency,
        status: "pending",
      },
    });

    const init = await initializePaystackTransaction({
      email,
      amountMinor: proration.chargeMinor,
      currency: proration.currency,
      reference,
      callbackUrl,
      metadata: {
        userId,
        changeId: change.id,
        subscriptionId: subscription.id,
        changeType: "upgrade",
        fromPlanId: fromPlan.id,
        toPlanId: toPlan.id,
        chargeMinor: proration.chargeMinor,
        creditMinor: proration.creditMinor,
        daysRemaining: proration.daysRemaining,
      },
    });

    paystackInitialized = true;
    paystackAuthorizationUrl = init.authorizationUrl;

    await persistInitiatedEvidence();

    return {
      kind: "created",
      authorizationUrl: init.authorizationUrl,
      reference,
      accessCode: init.accessCode,
      changeId: change.id,
      subscriptionId: subscription.id,
      fromPlan,
      toPlan,
      proration,
    };
  } catch (error) {
    if (paystackInitialized) {
      // 3b. A real Paystack transaction exists for `reference`. NEVER release
      //     the claim or delete the pending change: doing so would allow a
      //     retry to open a second independent Paystack transaction for the
      //     same pending upgrade while the first one remains untracked. The
      //     reservation alone is enough to keep future initiates converging
      //     on this exact reference; best-effort, re-persist the
      //     checkout.initiated evidence (P2002 means it already exists).
      if (change) {
        try {
          await persistInitiatedEvidence();
        } catch (persistError) {
          if (!isUniqueConstraintError(persistError)) {
            console.error(
              "Upgrade checkout evidence could not be persisted after Paystack initialization succeeded:",
              persistError
            );
          }
        }
      }
      throw error;
    }

    // 3c. Paystack was never successfully reached (initialization failed
    //     before a transaction existed) — it is safe to release the claim and
    //     remove the pending change so a retry can start completely fresh.
    await prisma.subscription.updateMany({
      where: { id: subscription.id, pendingUpgradeReference: reference },
      data: { pendingUpgradeReference: null },
    });
    if (change) {
      await prisma.subscriptionChange.deleteMany({
        where: { id: change.id, status: "pending" },
      });
    }
    throw error;
  }
}

/**
 * Atomically applies a verified upgrade payment to the existing
 * Subscription. Enforces exactly one plan transition, one applied
 * SubscriptionChange, and one payment.fulfilled event even under
 * concurrent browser-verification + webhook deliveries.
 */
export async function applyUpgrade(options: {
  provider?: string;
  providerReference: string;
}): Promise<FulfilmentResult> {
  const { provider = "paystack", providerReference } = options;

  if (!providerReference || typeof providerReference !== "string") {
    return { success: false, error: "Invalid provider reference." };
  }

  // 1. Idempotency: an already-fulfilled upgrade returns instantly.
  const existingFulfilled = await prisma.paymentEvent.findUnique({
    where: {
      provider_providerReference_eventType: {
        provider,
        providerReference,
        eventType: "payment.fulfilled",
      },
    },
  });

  if (existingFulfilled) {
    let subscription: (Subscription & { plan: Plan }) | null = null;
    if (existingFulfilled.subscriptionId) {
      subscription = await prisma.subscription.findUnique({
        where: { id: existingFulfilled.subscriptionId },
        include: { plan: true },
      });
    }
    return { success: true, idempotent: true, subscription: subscription ?? undefined };
  }

  // 2. Locate checkout initiation evidence.
  const initiatedEvent = await prisma.paymentEvent.findFirst({
    where: { provider, providerReference, eventType: "checkout.initiated" },
  });

  if (!initiatedEvent) {
    return {
      success: false,
      error: `No checkout initiation record found for reference '${providerReference}'.`,
    };
  }

  // 3. Confirm a matching verified payment event.
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
      error: `Cannot apply upgrade: Valid verified payment event not found for reference '${providerReference}'.`,
    };
  }

  // 4. Resolve the pending SubscriptionChange from checkout evidence.
  const initiatedPayload = parsePayload<InitiatedUpgradePayload>(
    initiatedEvent.payload
  );
  const changeId = initiatedPayload?.changeId;

  if (!changeId) {
    return {
      success: false,
      error: `Upgrade change identifier missing for reference '${providerReference}'.`,
    };
  }

  const change = await prisma.subscriptionChange.findUnique({
    where: { id: changeId },
    include: {
      subscription: { include: { plan: true } },
      fromPlan: true,
      toPlan: true,
    },
  });

  if (!change || change.changeType !== "upgrade") {
    return {
      success: false,
      error: `Pending upgrade change not found for reference '${providerReference}'.`,
    };
  }

  // 5. Ownership, amount and currency checks against stored values only.
  if (
    verifiedEvent.userId !== initiatedEvent.userId ||
    change.subscription.userId !== initiatedEvent.userId
  ) {
    return {
      success: false,
      conflict: true,
      error: "Payment ownership mismatch: reference does not belong to this user.",
    };
  }

  if (
    verifiedEvent.amountMinor !== change.chargeMinor ||
    verifiedEvent.currency.toUpperCase() !== change.currency.toUpperCase()
  ) {
    return {
      success: false,
      error: `Verified amount (${verifiedEvent.amountMinor} ${verifiedEvent.currency}) does not match stored upgrade charge (${change.chargeMinor} ${change.currency}).`,
    };
  }

  const subscription = change.subscription;
  const fromPlan = change.fromPlan;
  const toPlan = change.toPlan;

  // 6. Final eligibility guard at the instant of fulfilment.
  if (
    subscription.status !== "active" ||
    subscription.planId !== fromPlan.id ||
    subscription.cancelAtPeriodEnd
  ) {
    return {
      success: false,
      conflict: true,
      error: "Subscription is no longer active on the Monthly plan.",
    };
  }

  // 7. Apply the transition with conditional updates so that only one
  //    concurrent request can win the plan flip.
  const now = new Date();
  const newPeriod = calculateSubscriptionPeriod(now, toPlan.interval);

  const subUpdate = await prisma.subscription.updateMany({
    where: { id: subscription.id, planId: fromPlan.id, status: "active" },
    data: {
      planId: toPlan.id,
      amountMinor: toPlan.amountMinor,
      currency: toPlan.currency,
      currentPeriodStart: newPeriod.currentPeriodStart,
      currentPeriodEnd: newPeriod.currentPeriodEnd,
      pendingUpgradeReference: null,
    },
  });

  const currentSub = await prisma.subscription.findUnique({
    where: { id: subscription.id },
    include: { plan: true },
  });

  if (!currentSub) {
    return { success: false, error: "Subscription record no longer exists." };
  }

  if (subUpdate.count === 0 && currentSub.planId !== toPlan.id) {
    // This request lost the transition race and another request is
    // mid-flight; it will finish the fulfilled event. Treat as handled.
    return {
      success: true,
      idempotent: true,
      subscription: currentSub,
    };
  }

  // 8. Mark the change applied (only one request wins the status flip too).
  await prisma.subscriptionChange.updateMany({
    where: { id: change.id, status: "pending" },
    data: { status: "applied", effectiveAt: now },
  });

  // 9. Append immutable payment.fulfilled evidence (unique-key protected).
  try {
    await prisma.paymentEvent.create({
      data: {
        userId: initiatedEvent.userId,
        subscriptionId: currentSub.id,
        provider,
        providerReference,
        eventType: "payment.fulfilled",
        status: "fulfilled",
        amountMinor: change.chargeMinor,
        currency: change.currency,
        processedAt: now,
        payload: JSON.stringify({
          changeId: change.id,
          subscriptionId: currentSub.id,
          fromPlanId: fromPlan.id,
          toPlanId: toPlan.id,
          planName: toPlan.name,
          interval: toPlan.interval,
          creditMinor: change.creditMinor,
          chargeMinor: change.chargeMinor,
          daysRemaining: change.daysRemaining,
          currentPeriodStart: newPeriod.currentPeriodStart.toISOString(),
          currentPeriodEnd: newPeriod.currentPeriodEnd.toISOString(),
        }),
      },
    });
  } catch (err: unknown) {
    if (isUniqueConstraintError(err)) {
      const alreadyApplied = await prisma.subscription.findUnique({
        where: { id: currentSub.id },
        include: { plan: true },
      });
      return { success: true, idempotent: true, subscription: alreadyApplied ?? undefined };
    }
    console.error("Upgrade fulfilment error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to apply upgrade.",
    };
  }

  return { success: true, subscription: currentSub };
}

/**
 * Inspects the checkout evidence for a reference and reports whether the
 * initiation target was an upgrade payment. Used by the verify and webhook
 * routes to (a) pick the correct expected amount and (b) dispatch to the
 * correct idempotent fulfilment service.
 */
export async function resolveUpgradeChangeForInitiated(
  provider: string,
  providerReference: string
): Promise<SubscriptionChange | null> {
  const initiatedEvent = await prisma.paymentEvent.findFirst({
    where: { provider, providerReference, eventType: "checkout.initiated" },
  });

  if (!initiatedEvent) return null;

  const payload = parsePayload<InitiatedUpgradePayload>(initiatedEvent.payload);
  if (payload?.changeType !== "upgrade" || !payload?.changeId) return null;

  return prisma.subscriptionChange.findUnique({ where: { id: payload.changeId } });
}

/**
 * Single convergent fulfilment entry-point: routes either to the Stage 4
 * new-subscription fulfilment or the Stage 5 upgrade fulfilment so browser
 * verification and webhooks always converge on the same idempotent service.
 */
export async function fulfilVerifiedPayment(options: {
  provider?: string;
  providerReference: string;
}): Promise<FulfilmentResult> {
  const { provider = "paystack", providerReference } = options;

  const change = await resolveUpgradeChangeForInitiated(provider, providerReference);
  if (change) {
    return applyUpgrade({ provider, providerReference });
  }

  return fulfilSubscription({ provider, providerReference });
}