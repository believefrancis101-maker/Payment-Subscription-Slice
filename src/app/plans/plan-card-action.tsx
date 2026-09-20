"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import UpgradeCardAction from "./upgrade-card-action";
import CancelSubscriptionAction from "./cancel-subscription-action";

interface PlanCardActionProps {
  planId: string;
  planName: string;
  isCurrent: boolean;
  isPaid: boolean;
  hasActivePaidSubscription?: boolean;
  upgradeFromMonthly?: boolean;
  downgradeToMonthly?: boolean;
  downgradeScheduled?: boolean;
  downgradeEffectiveAt?: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string;
}

export default function PlanCardAction({
  planId,
  planName,
  isCurrent,
  isPaid,
  hasActivePaidSubscription,
  upgradeFromMonthly,
  downgradeToMonthly,
  downgradeScheduled,
  downgradeEffectiveAt,
  cancelAtPeriodEnd,
  currentPeriodEnd,
}: PlanCardActionProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<string | undefined>(
    downgradeEffectiveAt
  );

  const isScheduled = Boolean(downgradeScheduled || scheduled);
  const effectiveDate = scheduledDate || downgradeEffectiveAt;

  const formatEffectiveDate = (dateString?: string) => {
    if (!dateString) return "the end of your current billing period";
    const d = new Date(dateString);
    return !isNaN(d.getTime())
      ? d.toLocaleDateString("en-NG", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "the end of your current billing period";
  };

  if (isCurrent) {
    return (
      <div className="w-full space-y-2">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="w-full cursor-not-allowed rounded-lg border border-zinc-300 bg-zinc-100 py-2.5 px-4 text-center text-sm font-semibold text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
        >
          Current Plan
        </button>

        {hasActivePaidSubscription && isPaid && (
          <CancelSubscriptionAction
            planName={planName}
            cancelAtPeriodEnd={cancelAtPeriodEnd}
            currentPeriodEnd={currentPeriodEnd}
          />
        )}
      </div>
    );
  }

  // Active Yearly subscriber with a pending downgrade already scheduled to this Monthly plan
  if (isScheduled) {
    const formattedDate = formatEffectiveDate(effectiveDate);

    return (
      <div className="w-full space-y-2">
        <button
          id={`downgrade-scheduled-${planName.toLowerCase()}`}
          type="button"
          disabled
          aria-disabled="true"
          className="w-full cursor-not-allowed rounded-lg border border-amber-300 bg-amber-50 py-2.5 px-4 text-center text-sm font-semibold text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300"
        >
          Downgrade Scheduled
        </button>

        <p className="text-[11px] text-center text-zinc-500 dark:text-zinc-400">
          Your switch to {planName} is scheduled for {formattedDate}. Your Yearly plan remains active until then.
        </p>

        {notice && (
          <div
            role="status"
            className="rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
          >
            <p className="font-medium">Downgrade Scheduled</p>
            <p className="mt-0.5">{notice}</p>
          </div>
        )}
      </div>
    );
  }

  // Stage 5: active Monthly subscriber on the Yearly card shows the
  // server-priced prorated upgrade flow.
  if (upgradeFromMonthly) {
    return <UpgradeCardAction planId={planId} />;
  }

  // Stage 6: active Yearly subscriber on the Monthly card schedules
  // the downgrade for the end of the current Yearly billing period.
  if (downgradeToMonthly) {
    async function handleDowngrade() {
      try {
        setLoading(true);
        setError(null);
        setNotice(null);

        const response = await fetch("/api/subscriptions/downgrade", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ toPlanId: planId }),
        });

        if (response.status === 401) {
          router.push("/signin?next=/plans");
          return;
        }

        const data = await response.json().catch(() => null);

        if (!response.ok || !data?.success) {
          setError(
            data?.error ||
              `Unable to schedule downgrade (${response.status}).`
          );
          setLoading(false);
          return;
        }

        const effectiveAt = data.change?.effectiveAt
          ? new Date(data.change.effectiveAt)
          : null;

        const formattedDate = effectiveAt
          ? effectiveAt.toLocaleDateString("en-NG", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })
          : "the end of your current billing period";

        setNotice(
          data.idempotent
            ? `Your switch to ${planName} is already scheduled for ${formattedDate}.`
            : `Your switch to ${planName} is scheduled for ${formattedDate}. Your Yearly plan remains active until then.`
        );

        setScheduled(true);
        if (data.change?.effectiveAt) {
          setScheduledDate(data.change.effectiveAt);
        }
        setLoading(false);
        router.refresh();
      } catch (err) {
        console.error("Downgrade scheduling failed:", err);
        setError(
          err instanceof Error
            ? err.message
            : "An unexpected error occurred."
        );
        setLoading(false);
      }
    }

    return (
      <div className="w-full space-y-2">
        <button
          id={`downgrade-to-${planName.toLowerCase()}`}
          type="button"
          disabled={loading}
          onClick={handleDowngrade}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-zinc-900 bg-white py-2.5 px-4 text-center text-sm font-semibold text-zinc-900 shadow-sm transition-colors hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-75 dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-100 dark:focus:ring-offset-zinc-900"
        >
          {loading ? (
            <>
              <svg
                className="h-4 w-4 animate-spin text-current"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Scheduling...</span>
            </>
          ) : (
            `Switch to ${planName}`
          )}
        </button>

        <p className="text-[11px] text-center text-zinc-500 dark:text-zinc-400">
          Takes effect at the end of your current Yearly billing period.
        </p>

        {notice && (
          <div
            role="status"
            className="rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
          >
            <p className="font-medium">Downgrade Scheduled</p>
            <p className="mt-0.5">{notice}</p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            <p className="font-medium">Downgrade Notice</p>
            <p className="mt-0.5">{error}</p>
          </div>
        )}
      </div>
    );
  }

  // Active subscription protection: Do not allow purchasing another
  // paid plan unless a supported Stage 5/6 transition applies.
  if (hasActivePaidSubscription && isPaid) {
    return (
      <div className="w-full space-y-1.5">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-50 py-2.5 px-4 text-center text-xs font-medium text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
        >
          Plan Changes Handled in Next Stage
        </button>
        <p className="text-[11px] text-center text-zinc-400 dark:text-zinc-500">
          Upgrades & plan changes are not implemented at this stage.
        </p>
      </div>
    );
  }

  if (!isPaid) {
    return (
      <div className="w-full">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-50 py-2.5 px-4 text-center text-sm font-medium text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
        >
          Included
        </button>
      </div>
    );
  }

  async function handleCheckout() {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);

      const response = await fetch("/api/checkout/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ planId }),
      });

      if (response.status === 401) {
        router.push("/signin?next=/plans");
        return;
      }

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        const errorMsg =
          data?.error || `Checkout initiation failed (${response.status})`;
        setError(errorMsg);
        setLoading(false);
        return;
      }

      setNotice("Redirecting to Paystack test checkout...");

      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      } else {
        throw new Error("Missing checkout authorization URL.");
      }
    } catch (err) {
      console.error("Checkout initiation failed:", err);
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-2">
      <button
        id={`select-plan-${planName.toLowerCase()}`}
        type="button"
        disabled={loading}
        onClick={handleCheckout}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-zinc-900 py-2.5 px-4 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-75 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-zinc-900 dark:focus:ring-offset-zinc-900"
      >
        {loading ? (
          <>
            <svg
              className="h-4 w-4 animate-spin text-current"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0c-5.373 0-8 5.373-8 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span>Initiating Checkout...</span>
          </>
        ) : (
          `Upgrade to ${planName}`
        )}
      </button>

      {notice && (
        <div
          role="status"
          className="rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
        >
          <p className="font-medium">Paystack Test Sandbox</p>
          <p className="mt-0.5">{notice}</p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">Checkout Notice</p>
          <p className="mt-0.5">{error}</p>
        </div>
      )}
    </div>
  );
}