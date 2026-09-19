import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import { checkoutVerifySchema } from "@/lib/validation/checkout";
import { verifyPaystackTransaction } from "@/lib/paystack";
import { fulfilSubscription } from "@/lib/fulfilment";

const VERIFY_IP_LIMIT = { limit: 15, windowSeconds: 60 };
const VERIFY_USER_LIMIT = { limit: 10, windowSeconds: 60 };

export async function POST(request: NextRequest) {
  try {
    // 1. IP Rate Limiting
    const ip = getClientIp(request);
    const ipCheck = checkRateLimit(`verify:ip:${ip}`, VERIFY_IP_LIMIT);
    if (!ipCheck.success) {
      return rateLimitExceededResponse(
        `Too many verification requests from this IP. Please wait ${ipCheck.retryAfter} seconds.`,
        ipCheck
      );
    }

    // 2. Authentication Check
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized. You must be signed in to verify payment." },
        { status: 401 }
      );
    }

    // 3. User Rate Limiting
    const userCheck = checkRateLimit(`verify:user:${user.id}`, VERIFY_USER_LIMIT);
    if (!userCheck.success) {
      return rateLimitExceededResponse(
        `Too many verification requests for your account. Please wait ${userCheck.retryAfter} seconds.`,
        userCheck
      );
    }

    // 4. Request Body Validation
    const body = await request.json().catch(() => null);
    const validation = checkoutVerifySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed.",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { reference } = validation.data;

    // 5. Lookup Initial Checkout Event in Database
    const initiatedEvent = await prisma.paymentEvent.findFirst({
      where: {
        provider: "paystack",
        providerReference: reference,
        eventType: "checkout.initiated",
      },
    });

    if (!initiatedEvent) {
      return NextResponse.json(
        { error: "No checkout initiation found for the provided transaction reference." },
        { status: 404 }
      );
    }

    // 6. Enforce Ownership: Reject reference belonging to another user
    if (initiatedEvent.userId !== user.id) {
      return NextResponse.json(
        { error: "Forbidden. Transaction reference belongs to another user account." },
        { status: 403 }
      );
    }

    // 7. Extract Expected Plan Details from Initiation Record
    let expectedPlanId = "";
    if (initiatedEvent.payload) {
      try {
        const parsed = JSON.parse(initiatedEvent.payload);
        expectedPlanId = parsed.planId;
      } catch {
        // Ignore JSON parse error
      }
    }

    const plan = await prisma.plan.findUnique({
      where: { id: expectedPlanId },
    });

    if (!plan) {
      return NextResponse.json(
        { error: "Plan associated with this transaction was not found." },
        { status: 400 }
      );
    }

    // 8. Idempotency Pre-Check: Return existing verification if already processed
    const existingVerification = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: reference,
          eventType: "payment.verified",
        },
      },
    });

    if (existingVerification) {
      const fulfilment = await fulfilSubscription({
        provider: "paystack",
        providerReference: reference,
      });

      if (fulfilment.conflict) {
        return NextResponse.json(
          { error: fulfilment.error },
          { status: 409 }
        );
      }

      return NextResponse.json(
        {
          success: true,
          verified: true,
          fulfilled: fulfilment.success,
          idempotent: true,
          reference,
          amountMinor: existingVerification.amountMinor,
          currency: existingVerification.currency,
          planName: plan.name,
          subscriptionId: fulfilment.subscription?.id,
          currentPeriodStart: fulfilment.subscription?.currentPeriodStart,
          currentPeriodEnd: fulfilment.subscription?.currentPeriodEnd,
        },
        { status: 200 }
      );
    }

    // 9. Server-Side Verification via Paystack API
    const verifyResult = await verifyPaystackTransaction(reference);
    const txData = verifyResult.data;
    const providerStatus = (txData.status || "").toLowerCase();

    // 10. Integrity Checks (Domain, Reference, Amount, Currency)
    let integrityFailureReason: string | null = null;
    if (txData.domain !== "test") {
      integrityFailureReason = `Transaction domain is '${txData.domain}', expected 'test'.`;
    } else if (txData.reference !== reference) {
      integrityFailureReason = `Transaction reference '${txData.reference}' does not match expected reference '${reference}'.`;
    } else if (txData.amount !== plan.amountMinor) {
      integrityFailureReason = `Transaction amount (${txData.amount} minor units) does not match expected plan amount (${plan.amountMinor} minor units).`;
    } else if (txData.currency.toUpperCase() !== plan.currency.toUpperCase()) {
      integrityFailureReason = `Transaction currency '${txData.currency}' does not match expected plan currency '${plan.currency}'.`;
    }

    if (integrityFailureReason) {
      try {
        await prisma.paymentEvent.create({
          data: {
            userId: user.id,
            provider: "paystack",
            providerReference: reference,
            eventType: "payment.failed",
            status: "failed",
            amountMinor: txData?.amount ?? plan.amountMinor,
            currency: txData?.currency ?? plan.currency,
            processedAt: new Date(),
            payload: JSON.stringify({
              reason: integrityFailureReason,
              gatewayResponse: txData?.gateway_response,
              paystackStatus: providerStatus,
              actualAmount: txData?.amount,
              expectedAmount: plan.amountMinor,
            }),
          },
        });
      } catch (createErr: unknown) {
        const isUniqueConstraint =
          (createErr as { code?: string })?.code === "P2002" ||
          (createErr instanceof Error && createErr.message.includes("Unique constraint"));
        if (!isUniqueConstraint) {
          throw createErr;
        }
      }

      return NextResponse.json(
        {
          error: `Payment verification failed: ${integrityFailureReason}`,
          verified: false,
          status: "failed",
        },
        { status: 400 }
      );
    }

    // 11. Transaction Status Mapping
    // A. Pending / In-Progress Statuses: Do NOT create payment.failed
    const pendingStatuses = ["pending", "ongoing", "processing", "queued"];
    if (pendingStatuses.includes(providerStatus)) {
      return NextResponse.json(
        {
          success: false,
          verified: false,
          pending: true,
          status: providerStatus,
          reference,
          gatewayResponse: txData.gateway_response,
          message: `Transaction is currently ${providerStatus}. Please complete payment or wait for final confirmation.`,
        },
        { status: 200 }
      );
    }

    // B. Reversed Status: Do NOT classify as ordinary payment failure
    if (providerStatus === "reversed") {
      try {
        await prisma.paymentEvent.create({
          data: {
            userId: user.id,
            provider: "paystack",
            providerReference: reference,
            eventType: "payment.reversed",
            status: "reversed",
            amountMinor: txData.amount ?? plan.amountMinor,
            currency: txData.currency ?? plan.currency,
            processedAt: new Date(),
            payload: JSON.stringify({
              reason: "Transaction was reversed by payment provider.",
              gatewayResponse: txData.gateway_response,
              paystackStatus: providerStatus,
            }),
          },
        });
      } catch (createErr: unknown) {
        const isUniqueConstraint =
          (createErr as { code?: string })?.code === "P2002" ||
          (createErr instanceof Error && createErr.message.includes("Unique constraint"));
        if (!isUniqueConstraint) {
          throw createErr;
        }
      }

      return NextResponse.json(
        {
          success: false,
          verified: false,
          reversed: true,
          status: "reversed",
          reference,
          message: "Transaction has been reversed.",
        },
        { status: 400 }
      );
    }

    // C. Failed / Abandoned Statuses: Record payment.failed
    if (providerStatus !== "success") {
      const isAbandoned = providerStatus === "abandoned";
      const failureReason = isAbandoned
        ? "Checkout was abandoned by the user."
        : `Transaction status is '${providerStatus}'. Gateway response: ${txData.gateway_response}`;

      try {
        await prisma.paymentEvent.create({
          data: {
            userId: user.id,
            provider: "paystack",
            providerReference: reference,
            eventType: "payment.failed",
            status: "failed",
            amountMinor: txData?.amount ?? plan.amountMinor,
            currency: txData?.currency ?? plan.currency,
            processedAt: new Date(),
            payload: JSON.stringify({
              reason: failureReason,
              gatewayResponse: txData?.gateway_response,
              paystackStatus: providerStatus,
              actualAmount: txData?.amount,
              expectedAmount: plan.amountMinor,
            }),
          },
        });
      } catch (createErr: unknown) {
        const isUniqueConstraint =
          (createErr as { code?: string })?.code === "P2002" ||
          (createErr instanceof Error && createErr.message.includes("Unique constraint"));
        if (!isUniqueConstraint) {
          throw createErr;
        }
      }

      return NextResponse.json(
        {
          error: `Payment verification failed: ${failureReason}`,
          verified: false,
          status: "failed",
        },
        { status: 400 }
      );
    }

    // D. Successful Status: Record Verified PaymentEvent (No card credentials stored) with Concurrent P2002 Protection
    const sanitizedPayload = {
      planId: plan.id,
      planName: plan.name,
      interval: plan.interval,
      channel: txData.channel,
      gatewayResponse: txData.gateway_response,
      paidAt: txData.paid_at,
      domain: txData.domain,
    };

    try {
      await prisma.paymentEvent.create({
        data: {
          userId: user.id,
          provider: "paystack",
          providerReference: reference,
          eventType: "payment.verified",
          status: "verified",
          amountMinor: txData.amount,
          currency: txData.currency,
          processedAt: new Date(),
          payload: JSON.stringify(sanitizedPayload),
        },
      });
    } catch (createErr: unknown) {
      const isUniqueConstraint =
        (createErr as { code?: string })?.code === "P2002" ||
        (createErr instanceof Error && createErr.message.includes("Unique constraint"));
      if (!isUniqueConstraint) {
        throw createErr;
      }
    }

    // 12. Fulfil Subscription (Stage 4 Entitlement)
    const fulfilment = await fulfilSubscription({
      provider: "paystack",
      providerReference: reference,
    });

    if (fulfilment.conflict) {
      return NextResponse.json(
        { error: fulfilment.error },
        { status: 409 }
      );
    }

    if (!fulfilment.success) {
      return NextResponse.json(
        { error: fulfilment.error || "Subscription fulfilment failed." },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        verified: true,
        fulfilled: true,
        reference,
        amountMinor: txData.amount,
        currency: txData.currency,
        planName: plan.name,
        subscriptionId: fulfilment.subscription?.id,
        currentPeriodStart: fulfilment.subscription?.currentPeriodStart,
        currentPeriodEnd: fulfilment.subscription?.currentPeriodEnd,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Payment verification error:", error);
    const message =
      error instanceof Error ? error.message : "Payment verification failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
