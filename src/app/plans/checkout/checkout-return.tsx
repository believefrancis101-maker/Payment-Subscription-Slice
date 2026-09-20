"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type VerificationStatus = "verifying" | "success" | "error";

interface CheckoutReturnProps {
  reference?: string | string[];
}

export default function CheckoutReturn({ reference }: CheckoutReturnProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const verificationStarted = useRef(false);
  const [retryTrigger, setRetryTrigger] = useState(0);
  const [status, setStatus] = useState<VerificationStatus>("verifying");
  const [message, setMessage] = useState("Verifying your payment...");

  // Resolve reference string safely from prop or searchParams fallback
  const rawRef =
    (Array.isArray(reference) ? reference[0] : reference) ||
    searchParams.get("reference") ||
    searchParams.get("trxref") ||
    "";
  const targetReference = typeof rawRef === "string" ? rawRef.trim() : "";

  useEffect(() => {
    if (!targetReference) {
      return;
    }

    if (verificationStarted.current) {
      return;
    }
    verificationStarted.current = true;

    async function verifyPayment() {
      try {
        const response = await fetch("/api/checkout/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: targetReference }),
        });

        // Unauthorized — redirect to sign-in
        if (response.status === 401) {
          router.push("/signin?next=/plans");
          return;
        }

        const data = await response.json().catch(() => null);

        if (!response.ok || !data?.success) {
          setStatus("error");
          const fieldDetails = data?.details?.reference
            ? Array.isArray(data.details.reference)
              ? ` (${data.details.reference.join(", ")})`
              : ` (${data.details.reference})`
            : "";
          setMessage(
            data?.error
              ? `${data.error}${fieldDetails}`
              : `Payment verification failed (${response.status}). Please try again or contact support.`
          );
          return;
        }

        // Success (covers both first-time and idempotent re-verification)
        setStatus("success");
        setMessage(
          data.idempotent
            ? "Payment verified successfully (already verified). Redirecting to dashboard..."
            : "Payment verified successfully. Redirecting to dashboard..."
        );

        // Brief delay so the user sees the confirmation before redirect
        await new Promise((resolve) => setTimeout(resolve, 1200));

        router.replace("/dashboard");
        router.refresh();
      } catch (error) {
        console.error("Payment verification failed:", error);
        setStatus("error");
        setMessage(
          "A network error occurred while verifying your payment. Please check your connection and click Retry Verification."
        );
      }
    }

    verifyPayment();
  }, [targetReference, retryTrigger, router]);

  // Handle missing reference explicitly as per requirement 7
  if (!targetReference) {
    return (
      <div
        id="checkout-return-status"
        role="alert"
        aria-live="polite"
        className="mb-8 rounded-xl border border-amber-300/80 bg-gradient-to-r from-amber-50 to-orange-50 p-4 shadow-sm text-amber-900 dark:border-amber-700/50 dark:from-amber-950/40 dark:to-orange-950/30 dark:text-amber-200"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold dark:bg-amber-900 dark:text-amber-200">
            ⚠️
          </span>
          <div>
            <h2 className="text-sm font-semibold">Missing Transaction Reference</h2>
            <p className="mt-0.5 text-xs sm:text-sm">
              We could not find a transaction reference in the redirect URL. Unable to verify payment.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const bannerStyles: Record<VerificationStatus, string> = {
    verifying:
      "border-blue-300/80 bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-800 dark:border-blue-700/50 dark:from-blue-950/40 dark:to-indigo-950/30 dark:text-blue-300",
    success:
      "border-emerald-300/80 bg-gradient-to-r from-emerald-50 to-green-50 text-emerald-800 dark:border-emerald-700/50 dark:from-emerald-950/40 dark:to-green-950/30 dark:text-emerald-300",
    error:
      "border-red-300/80 bg-gradient-to-r from-red-50 to-rose-50 text-red-800 dark:border-red-700/50 dark:from-red-950/40 dark:to-rose-950/30 dark:text-red-300",
  };

  const icons: Record<VerificationStatus, string> = {
    verifying: "⏳",
    success: "✅",
    error: "❌",
  };

  const headings: Record<VerificationStatus, string> = {
    verifying: "Verifying Payment",
    success: "Payment Verified",
    error: "Verification Failed",
  };

  const handleRetry = () => {
    verificationStarted.current = false;
    setStatus("verifying");
    setMessage("Verifying your payment...");
    setRetryTrigger((prev) => prev + 1);
  };

  return (
    <div
      id="checkout-return-status"
      role="status"
      aria-live="polite"
      className={`mb-8 rounded-xl border p-4 shadow-sm ${bannerStyles[status]}`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/60 text-sm dark:bg-white/10">
          {status === "verifying" ? (
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
          ) : (
            icons[status]
          )}
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold">{headings[status]}</h2>
          <p className="mt-0.5 text-xs sm:text-sm">{message}</p>
          {status === "error" && (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 rounded-md bg-white/80 px-3 py-1 text-xs font-medium shadow-sm transition-colors hover:bg-white text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
            >
              Retry Verification
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
