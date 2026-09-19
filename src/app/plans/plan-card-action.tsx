"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PlanCardActionProps {
  planId: string;
  planName: string;
  isCurrent: boolean;
  isPaid: boolean;
}

export default function PlanCardAction({
  planId,
  planName,
  isCurrent,
  isPaid,
}: PlanCardActionProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);


  if (isCurrent) {
    return (
      <div className="w-full">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="w-full cursor-not-allowed rounded-lg border border-zinc-300 bg-zinc-100 py-2.5 px-4 text-center text-sm font-semibold text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
        >
          Current Plan
        </button>
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

      // Redirect user to Paystack's hosted checkout page
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
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-zinc-900 py-2.5 px-4 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-75 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-offset-zinc-900"
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

