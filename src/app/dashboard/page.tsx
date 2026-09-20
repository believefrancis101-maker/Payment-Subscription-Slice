import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import {
  getUserActiveSubscription,
  formatPrice,
  getUserPaymentHistory,
} from "@/lib/subscriptions";
import SignOutButton from "./sign-out-button";
import CancelSubscriptionAction from "../plans/cancel-subscription-action";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/signin");
  }

  const [activeSubscription, paymentHistory] = await Promise.all([
    getUserActiveSubscription(user.id),
    getUserPaymentHistory(user.id),
  ]);

  const currentPlanName = activeSubscription ? activeSubscription.plan.name : "Free";

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  };

  const formatDateTime = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  };

  const formatEventType = (eventType: string) => {
    switch (eventType) {
      case "checkout.initiated":
        return "Checkout Initiated";
      case "payment.verified":
        return "Payment Verified";
      case "payment.fulfilled":
        return "Subscription Fulfilled";
      case "payment.failed":
        return "Payment Failed";
      case "payment.reversed":
        return "Payment Reversed";
      default:
        return eventType
          .split(".")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status.toLowerCase()) {
      case "verified":
      case "fulfilled":
      case "success":
      case "active":
        return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300";
      case "pending":
      case "ongoing":
      case "processing":
        return "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300";
      case "failed":
      case "abandoned":
        return "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300";
      case "reversed":
        return "bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300";
      default:
        return "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200";
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 p-4 sm:p-6 dark:bg-zinc-950">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 text-2xl font-bold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
            {(user.name || user.email)[0].toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              {user.name || user.email}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Current Plan:{" "}
              <span
                id="current-plan-badge"
                className="inline-flex items-center rounded-md bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {currentPlanName}
              </span>
            </p>
          </div>

          {activeSubscription && (
            <div
              id="billing-details-card"
              className="w-full text-left rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/40 space-y-2 text-xs"
            >
              <div className="flex justify-between items-center pb-2 border-b border-zinc-200 dark:border-zinc-700/60">
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                  Billing Information
                </span>
                {activeSubscription.cancelAtPeriodEnd ? (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 capitalize">
                    Cancels at period end
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 capitalize">
                    {activeSubscription.status}
                  </span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Plan Rate</span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {formatPrice(activeSubscription.amountMinor, activeSubscription.currency)} / {activeSubscription.plan.interval}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Current Period Start</span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {formatDate(activeSubscription.currentPeriodStart)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">
                  {activeSubscription.cancelAtPeriodEnd ? "Access Until" : "Renewal / Period End"}
                </span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {formatDate(activeSubscription.currentPeriodEnd)}
                </span>
              </div>

              {activeSubscription.plan.amountMinor > 0 && (
                <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700/60">
                  <CancelSubscriptionAction
                    planName={activeSubscription.plan.name}
                    currentPeriodEnd={activeSubscription.currentPeriodEnd}
                    cancelAtPeriodEnd={activeSubscription.cancelAtPeriodEnd}
                  />
                </div>
              )}
            </div>
          )}

          {paymentHistory && paymentHistory.length > 0 && (
            <div
              id="payment-history-card"
              className="w-full text-left rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/40 space-y-2.5 text-xs"
            >
              <div className="flex justify-between items-center pb-2 border-b border-zinc-200 dark:border-zinc-700/60">
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                  Payment History
                </span>
                <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {paymentHistory.length} event{paymentHistory.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="divide-y divide-zinc-200 dark:divide-zinc-700/60 max-h-72 overflow-y-auto pr-1">
                {paymentHistory.map((item) => (
                  <div key={item.id} className="py-2.5 first:pt-0 last:pb-0 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {formatEventType(item.eventType)}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${getStatusBadgeClass(item.status)}`}
                      >
                        {item.status}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
                      <span>Amount</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {formatPrice(item.amountMinor, item.currency)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
                      <span>Reference</span>
                      <span className="font-mono text-[10px] text-zinc-700 dark:text-zinc-300 break-all select-all">
                        {item.providerReference}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
                      <span>Date & Time</span>
                      <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                        {formatDateTime(item.processedAt || item.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex w-full flex-col gap-3">
            <Link
              id="view-plans-btn"
              href="/plans"
              className="flex w-full items-center justify-center rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Manage & View Plans →
            </Link>
            <SignOutButton />
          </div>
        </div>
      </div>
    </main>
  );
}

