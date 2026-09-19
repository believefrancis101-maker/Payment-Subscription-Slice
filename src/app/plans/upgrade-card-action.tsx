"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface UpgradeQuote {
  currentPlan: {
    name: string;
    interval: string;
  };
  targetPlan: {
    name: string;
    interval: string;
  };
  currentPeriodEnd: string;
  proration: {
    currentPeriodDays: number;
    daysRemaining: number;
    oldPeriodAmountMinor: number;
    newPeriodAmountMinor: number;
    creditMinor: number;
    chargeMinor: number;
    currency: string;
  };
}

function formatMinor(amountMinor: number, currency = "NGN"): string {
  const majorUnits = amountMinor / 100;
  const currencyCode = currency.toUpperCase() === "NGN" ? "NGN" : currency;
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(majorUnits);
}

interface UpgradeCardActionProps {
  planId: string;
}

export default function UpgradeCardAction({ planId }: UpgradeCardActionProps) {
  const router = useRouter();
  const [quote, setQuote] = useState<UpgradeQuote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadQuote() {
      try {
        setError(null);
        const response = await fetch("/api/subscriptions/upgrade/quote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });

        if (response.status === 401) {
          router.push("/signin?next=/plans");
          return;
        }

        const data = await response.json().catch(() => null);

        if (!response.ok || !data?.success) {
          throw new Error(
            data?.error || `Failed to load upgrade quote (${response.status})`
          );
        }

        if (!cancelled) setQuote(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load upgrade quote."
          );
        }
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }

    loadQuote();

    return () => {
      cancelled = true;
    };
  }, [planId, router]);

  async function handleConfirm() {
    try {
      setConfirming(true);
      setError(null);

      const response = await fetch("/api/subscriptions/upgrade/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (response.status === 401) {
        router.push("/signin?next=/plans");
        return;
      }

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        setError(data?.error || `Failed to initiate upgrade (${response.status})`);
        setConfirming(false);
        return;
      }

      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      } else {
        throw new Error("Missing checkout authorization URL.");
      }
    } catch (err) {
      console.error("Upgrade initiation failed:", err);
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
      setConfirming(false);
    }
  }

  if (loadingQuote) {
    return (
      <div className="w-full">
        <button
          type="button"
          disabled
          className="w-full cursor-wait rounded-lg border border-zinc-200 bg-zinc-50 py-2.5 px-4 text-center text-sm font-medium text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
        >
          Loading proration quote...
        </button>
      </div>
    );
  }

  if (!quote) {
    return (
      <div className="w-full space-y-2">
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-50 py-2.5 px-4 text-center text-sm font-medium text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
        >
          Upgrade to Yearly
        </button>
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            <p className="font-medium">Upgrade Notice</p>
            <p className="mt-0.5">{error}</p>
          </div>
        )}
      </div>
    );
  }

  const p = quote.proration;

  return (
    <div className="w-full space-y-2.5">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
        <p className="font-semibold">Prorated Upgrade Quote</p>
        <ul className="mt-2 space-y-1.5">
          <li className="flex items-center justify-between gap-3">
            <span>Monthly price</span>
            <span className="font-medium">
              {formatMinor(p.oldPeriodAmountMinor, p.currency)}
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>Days remaining in current period</span>
            <span className="font-medium">
              {p.daysRemaining} of {p.currentPeriodDays} days
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>Unused-plan credit</span>
            <span className="font-medium text-emerald-700 dark:text-emerald-300">
              {formatMinor(p.creditMinor, p.currency)}
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>Yearly price</span>
            <span className="font-medium">
              {formatMinor(p.newPeriodAmountMinor, p.currency)}
            </span>
          </li>
          <li className="mt-1 flex items-center justify-between gap-3 border-t border-emerald-200 pt-2 dark:border-emerald-900/50">
            <span className="font-semibold">Amount due today</span>
            <span className="font-bold">
              {formatMinor(p.chargeMinor, p.currency)}
            </span>
          </li>
        </ul>
        <p className="mt-2 text-[11px] text-emerald-700/90 dark:text-emerald-300/80">
          On confirmation you will pay {formatMinor(p.chargeMinor, p.currency)}{" "}
          once via Paystack test checkout. After verified payment, your current
          subscription switches to {quote.targetPlan.name}: the new Yearly
          period begins at the upgrade time and ends one calendar year later.
        </p>
      </div>

      <button
        id="confirm-upgrade-yearly"
        type="button"
        disabled={confirming}
        onClick={handleConfirm}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 px-4 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-75 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
      >
        {confirming ? (
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
            <span>Confirming Upgrade...</span>
          </>
        ) : (
          `Confirm Upgrade & Pay ${formatMinor(p.chargeMinor, p.currency)}`
        )}
      </button>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">Upgrade Notice</p>
          <p className="mt-0.5">{error}</p>
        </div>
      )}
    </div>
  );
}