import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";

import {
  getActivePlans,
  getUserActiveSubscription,
  formatPrice,
  formatIntervalLabel,
} from "@/lib/subscriptions";
import { getPendingDowngrade } from "@/lib/downgrades";
import PlanCardAction from "./plan-card-action";
import SignOutButton from "../dashboard/sign-out-button";
import CheckoutReturn from "./checkout/checkout-return";

export const metadata = {
  title: "Subscription Plans — Test Mode",
  description: "Manage your subscription plan and billing interval.",
};

const PLAN_FEATURES: Record<string, string[]> = {
  Free: [
    "Standard access to basic features",
    "Community support",
    "Single active workspace",
  ],
  Monthly: [
    "Full access to premium features",
    "Priority email support",
    "Unlimited active workspaces",
    "Flexible monthly billing cycle",
  ],
  Yearly: [
    "Everything in Monthly plan",
    "Two months free (16% savings)",
    "Highest priority support SLA",
    "Annual billing with single invoice",
  ],
};

interface PlansPageProps {
  searchParams?: Promise<{
    checkout_status?: string | string[];
    reference?: string | string[];
    trxref?: string | string[];
  }>;
}

export default async function PlansPage({ searchParams }: PlansPageProps) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/signin?next=/plans");
  }

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const rawStatus = resolvedSearchParams.checkout_status;
  const checkout_status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;

  const rawReference = resolvedSearchParams.reference ?? resolvedSearchParams.trxref;
  const reference = Array.isArray(rawReference) ? rawReference[0] : rawReference;

  const [plans, activeSubscription] = await Promise.all([
    getActivePlans(),
    getUserActiveSubscription(user.id),
  ]);

  const pendingDowngrade = activeSubscription
    ? await getPendingDowngrade(activeSubscription.id)
    : null;


  // Determine current active plan:
  // If user has an active paid subscription, that plan is active.
  // Otherwise, the default is the Free plan.
  const activePlanId = activeSubscription ? activeSubscription.planId : null;
  const hasActivePaidSubscription = Boolean(activeSubscription && activeSubscription.plan.amountMinor > 0);

  // Stage 5: a user on an active Monthly plan may upgrade to Yearly.
  const isUpgradeEligible = Boolean(
    activeSubscription &&
    activeSubscription.plan.amountMinor > 0 &&
    activeSubscription.plan.interval.toLowerCase() === "monthly" &&
    !activeSubscription.cancelAtPeriodEnd
  );
  // Stage 6: a user on an active Yearly plan may schedule a downgrade to Monthly.
  const isDowngradeEligible = Boolean(
    activeSubscription &&
    activeSubscription.plan.amountMinor > 0 &&
    activeSubscription.plan.interval.toLowerCase() === "yearly" &&
    !activeSubscription.cancelAtPeriodEnd
  );
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      {/* Top Navigation */}
      <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80 sticky top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
            >
              ← Back to Dashboard
            </Link>
            <span className="text-zinc-300 dark:text-zinc-700">|</span>
            <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Billing & Subscriptions
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs text-zinc-500 dark:text-zinc-400">
              {user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {/* Test Mode Banner */}
        <div
          id="test-mode-banner"
          className="mb-8 rounded-xl border border-amber-300/80 bg-gradient-to-r from-amber-50 to-orange-50 p-4 shadow-sm dark:border-amber-700/50 dark:from-amber-950/40 dark:to-orange-950/30"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-900 dark:bg-amber-900 dark:text-amber-200">
              🧪
            </span>
            <div>
              <h2 className="text-sm font-semibold text-amber-950 dark:text-amber-200">
                Payment Test Mode Active
              </h2>
              <p className="mt-0.5 text-xs sm:text-sm text-amber-800 dark:text-amber-300/90">
                This environment is configured for test mode. All payment operations run using Paystack sandbox test credentials. No real cards will be charged.
              </p>
            </div>
          </div>
        </div>

        {/* Checkout Return: verify payment server-side and redirect to dashboard */}
        {checkout_status === "completed" && (
          <CheckoutReturn reference={reference} />
        )}


        {/* Header Title */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-4xl">
            Choose Your Plan
          </h1>
          <p className="mt-3 text-base text-zinc-600 dark:text-zinc-400 max-w-xl mx-auto">
            Upgrade or manage your subscription. In test mode, all billing operations are simulated safely with sandbox verification.
          </p>
        </div>

        {/* Plans Grid */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:gap-8">
          {plans.map((plan) => {
            const isPaid = plan.amountMinor > 0;
            const isCurrent = activePlanId
              ? activePlanId === plan.id
              : plan.name.toLowerCase() === "free";
            const isPopular = plan.name.toLowerCase() === "yearly";

            const features = PLAN_FEATURES[plan.name] || [
              "Standard feature access",
              "Customer support",
            ];

            const isDowngradeScheduled = Boolean(
              isDowngradeEligible && pendingDowngrade?.toPlanId === plan.id
            );

            return (
              <div
                key={plan.id}
                id={`plan-card-${plan.name.toLowerCase()}`}
                className={`relative flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-sm transition-all dark:bg-zinc-900 ${isCurrent
                    ? "border-zinc-900 ring-2 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100"
                    : isPopular
                      ? "border-zinc-400 dark:border-zinc-600"
                      : "border-zinc-200 dark:border-zinc-800"
                  }`}
              >
                {/* Badges */}
                <div className="absolute -top-3 right-6 flex items-center gap-1.5">
                  {isCurrent && (
                    <span
                      id={`current-badge-${plan.name.toLowerCase()}`}
                      className="rounded-full bg-zinc-900 px-3 py-0.5 text-xs font-semibold uppercase tracking-wider text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Current Plan
                    </span>
                  )}
                  {isPopular && !isCurrent && (
                    <span className="rounded-full bg-emerald-600 px-3 py-0.5 text-xs font-semibold uppercase tracking-wider text-white shadow-sm dark:bg-emerald-500">
                      Best Value
                    </span>
                  )}
                </div>

                <div>
                  <div className="mb-4">
                    <h3 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                      {plan.name}
                    </h3>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 capitalize">
                      Billing interval: {plan.interval}
                    </p>
                  </div>

                  <div className="mb-6 flex items-baseline gap-1.5">
                    <span className="text-4xl font-extrabold tracking-tight text-zinc-900 dark:text-zinc-50">
                      {formatPrice(plan.amountMinor, plan.currency)}
                    </span>
                    <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                      {formatIntervalLabel(plan.interval)}
                    </span>
                  </div>

                  {/* Feature list */}
                  <ul className="mb-8 space-y-3 text-sm text-zinc-600 dark:text-zinc-300">
                    {features.map((feature, idx) => (
                      <li key={idx} className="flex items-start gap-2.5">
                        <svg
                          className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth="2.5"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4.5 12.75l6 6 9-13.5"
                          />
                        </svg>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Plan Card Action Button */}
                <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                  <PlanCardAction
                    planId={plan.id}
                    planName={plan.name}
                    isCurrent={isCurrent}
                    isPaid={isPaid}
                    hasActivePaidSubscription={hasActivePaidSubscription}
                    upgradeFromMonthly={
                      isUpgradeEligible && !isCurrent && plan.name.toLowerCase() === "yearly"
                    }
                    downgradeToMonthly={
                      isDowngradeEligible &&
                      !isCurrent &&
                      plan.name.toLowerCase() === "monthly" &&
                      !isDowngradeScheduled
                    }
                    downgradeScheduled={isDowngradeScheduled}
                    downgradeEffectiveAt={pendingDowngrade?.effectiveAt.toISOString()}
                    cancelAtPeriodEnd={Boolean(activeSubscription?.cancelAtPeriodEnd)}
                    currentPeriodEnd={activeSubscription?.currentPeriodEnd.toISOString()}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer Note */}
        <div className="mt-12 text-center text-xs text-zinc-500 dark:text-zinc-500">
          <p>
            Subscription entitlements are verified server-side. No mock client tokens or unverified state are accepted.
          </p>
        </div>
      </main>
    </div>
  );
}
