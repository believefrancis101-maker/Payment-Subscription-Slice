"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface CancelSubscriptionActionProps {
  planName: string;
  currentPeriodEnd?: string | Date;
  cancelAtPeriodEnd?: boolean;
}

export default function CancelSubscriptionAction({
  planName,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
}: CancelSubscriptionActionProps) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [isCancelled, setIsCancelled] = useState(cancelAtPeriodEnd);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatDate = (dateInput?: string | Date) => {
    if (!dateInput) return "the end of your current billing period";
    try {
      const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
      if (isNaN(d.getTime())) return "the end of your current billing period";
      return new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(d);
    } catch {
      return "the end of your current billing period";
    }
  };

  const formattedDate = formatDate(currentPeriodEnd);

  // When cancellation is already scheduled (from server state or after confirmation)
  if (isCancelled || cancelAtPeriodEnd) {
    return (
      <div
        id="cancellation-scheduled-banner"
        role="status"
        className="w-full rounded-lg border border-amber-300/80 bg-amber-50/70 p-3 text-left text-xs text-amber-900 shadow-sm dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <div className="flex items-center gap-1.5 font-semibold">
          <span>⚠️</span>
          <span>Cancellation Scheduled</span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
          Your {planName} subscription remains active until {formattedDate}. It will not renew after that date.
        </p>
      </div>
    );
  }

  async function handleConfirmCancel() {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch("/api/subscriptions/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: reason.trim() || undefined,
        }),
      });

      if (response.status === 401) {
        router.push("/signin?next=/plans");
        return;
      }

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        setError(data?.error || `Failed to cancel subscription (${response.status}).`);
        setLoading(false);
        return;
      }

      setIsCancelled(true);
      setShowConfirm(false);
      setLoading(false);
      router.refresh();
    } catch (err) {
      console.error("Cancellation failed:", err);
      setError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred while scheduling cancellation."
      );
      setLoading(false);
    }
  }

  return (
    <div className="w-full">
      {!showConfirm ? (
        <div className="text-center pt-2">
          <button
            id="cancel-subscription-btn"
            type="button"
            onClick={() => setShowConfirm(true)}
            className="text-xs font-medium text-red-600 hover:text-red-700 underline underline-offset-2 transition-colors dark:text-red-400 dark:hover:text-red-300"
          >
            Cancel Subscription
          </button>
        </div>
      ) : (
        <div
          id="cancellation-confirmation-modal"
          role="alertdialog"
          aria-labelledby="cancel-title"
          aria-describedby="cancel-desc"
          className="rounded-lg border border-red-200 bg-red-50/70 p-3.5 text-left text-xs text-red-950 shadow-sm dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 space-y-2.5"
        >
          <div>
            <h4 id="cancel-title" className="font-semibold text-red-900 dark:text-red-100">
              Cancel subscription?
            </h4>
            <p id="cancel-desc" className="mt-1 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              Your subscription will remain active until <span className="font-semibold text-zinc-900 dark:text-zinc-100">{formattedDate}</span>. You will not be charged for another period after cancellation.
            </p>
          </div>

          <div>
            <label
              htmlFor="cancel-reason"
              className="block text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1"
            >
              Reason (optional):
            </label>
            <input
              id="cancel-reason"
              type="text"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Too expensive, no longer needed..."
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          {error && (
            <p role="alert" className="text-[11px] font-medium text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              id="keep-subscription-btn"
              type="button"
              disabled={loading}
              onClick={() => {
                setShowConfirm(false);
                setError(null);
              }}
              className="flex-1 rounded-md border border-zinc-300 bg-white py-1.5 px-2.5 text-center text-xs font-semibold text-zinc-700 shadow-sm hover:bg-zinc-50 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Keep Subscription
            </button>
            <button
              id="confirm-cancel-btn"
              type="button"
              disabled={loading}
              onClick={handleConfirmCancel}
              className="flex-1 rounded-md bg-red-600 py-1.5 px-2.5 text-center text-xs font-semibold text-white shadow-sm hover:bg-red-700 focus:outline-none disabled:opacity-50 transition-colors"
            >
              {loading ? "Cancelling..." : "Cancel at Period End"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
