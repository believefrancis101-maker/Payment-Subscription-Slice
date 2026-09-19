"use client";

import { useState } from "react";

interface PlanCardActionProps {
  planId: string;
  planName: string;
  isCurrent: boolean;
  isPaid: boolean;
}

export default function PlanCardAction({
  planName,
  isCurrent,
  isPaid,
}: PlanCardActionProps) {
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

  function handleSelect() {
    // In this first phase, checkout provider logic is not yet wired up.
    // Subscription entitlement only occurs via server-verified payment in later steps.
    setNotice(
      `Paystack checkout for ${planName} plan will be connected in the checkout phase. Payments will run in Test Mode.`
    );
  }

  return (
    <div className="w-full space-y-2">
      <button
        id={`select-plan-${planName.toLowerCase()}`}
        type="button"
        onClick={handleSelect}
        className="w-full rounded-lg bg-zinc-900 py-2.5 px-4 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-offset-zinc-900"
      >
        Upgrade to {planName}
      </button>

      {notice && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <p className="font-medium">Test Mode Notice</p>
          <p className="mt-0.5">{notice}</p>
        </div>
      )}
    </div>
  );
}
