import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { verifyPaystackSignature } from "@/lib/paystack";
import { fulfilSubscription } from "@/lib/fulfilment";

export async function POST(request: NextRequest) {
  try {
    // 1. Read Raw Body as Text for Exact HMAC Signature Calculation
    const rawBody = await request.text();
    const signature = request.headers.get("x-paystack-signature");

    // 2. Verify HMAC SHA512 Signature BEFORE Processing
    const isSignatureValid = verifyPaystackSignature(rawBody, signature);
    if (!isSignatureValid) {
      return NextResponse.json(
        { error: "Invalid or missing Paystack webhook signature." },
        { status: 401 }
      );
    }

    // 3. Parse Webhook Event JSON
    let eventPayload: {
      event?: string;
      data?: {
        reference?: string;
        amount?: number;
        currency?: string;
        status?: string;
        channel?: string;
        gateway_response?: string;
        paid_at?: string;
        domain?: string;
        customer?: {
          email?: string;
          customer_code?: string;
        };
        metadata?: {
          userId?: string;
          planId?: string;
          planName?: string;
        };
      };
    };

    try {
      eventPayload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON payload in webhook." },
        { status: 400 }
      );
    }

    const eventName = eventPayload.event;
    const txData = eventPayload.data;

    // Paystack officially emits 'charge.success' for successful charge transactions.
    // Unhandled or other events are acknowledged gracefully with 200 OK.
    if (eventName !== "charge.success") {
      return NextResponse.json(
        { received: true, ignored: true, message: `Event '${eventName}' acknowledged.` },
        { status: 200 }
      );
    }

    if (!txData) {
      return NextResponse.json(
        { error: "Missing data payload in webhook event." },
        { status: 400 }
      );
    }

    const reference = txData.reference;
    if (!reference) {
      return NextResponse.json(
        { error: `Missing transaction reference in ${eventName} payload.` },
        { status: 400 }
      );
    }

    // 4. Pre-check Webhook Idempotency for payment.verified
    const existingEvent = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: reference,
          eventType: "payment.verified",
        },
      },
    });

    if (existingEvent) {
      // Ensure subscription fulfilment has been processed idempotently
      await fulfilSubscription({
        provider: "paystack",
        providerReference: reference,
      });

      return NextResponse.json(
        {
          received: true,
          idempotent: true,
          message: "Transaction payment.verified event has already been recorded.",
        },
        { status: 200 }
      );
    }

    // 5. Locate Associated User & Plan from checkout.initiated record
    const initiatedEvent = await prisma.paymentEvent.findFirst({
      where: {
        provider: "paystack",
        providerReference: reference,
        eventType: "checkout.initiated",
      },
    });

    let userId = initiatedEvent?.userId || txData.metadata?.userId;
    let planId = "";

    if (initiatedEvent?.payload) {
      try {
        const parsed = JSON.parse(initiatedEvent.payload);
        planId = parsed.planId;
      } catch {
        // Ignore JSON parse error
      }
    }

    if (!planId && txData.metadata?.planId) {
      planId = txData.metadata.planId;
    }

    if (!userId && txData.customer?.email) {
      const user = await prisma.user.findUnique({
        where: { email: txData.customer.email.toLowerCase().trim() },
      });
      if (user) {
        userId = user.id;
      }
    }

    if (!userId) {
      return NextResponse.json(
        { error: "Unable to match transaction to a user account." },
        { status: 400 }
      );
    }

    // 7. Validate Plan Amounts for charge.success
    if (planId) {
      const plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (plan) {
        if (
          txData.amount !== plan.amountMinor ||
          txData.currency?.toUpperCase() !== plan.currency.toUpperCase()
        ) {
          try {
            await prisma.paymentEvent.create({
              data: {
                userId,
                provider: "paystack",
                providerReference: reference,
                eventType: "payment.failed",
                status: "failed",
                amountMinor: txData.amount ?? 0,
                currency: txData.currency ?? "NGN",
                processedAt: new Date(),
                payload: JSON.stringify({
                  reason: "Webhook amount/currency mismatch with database plan.",
                  expectedAmount: plan.amountMinor,
                  receivedAmount: txData.amount,
                  expectedCurrency: plan.currency,
                  receivedCurrency: txData.currency,
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
            { error: "Payment verification failed: Amount/currency mismatch." },
            { status: 400 }
          );
        }
      }
    }

    // 8. Sanitize Payload (Never store card numbers, CVV, or PIN)
    const sanitizedVerifiedPayload = {
      event: eventName,
      reference,
      channel: txData.channel,
      gatewayResponse: txData.gateway_response,
      paidAt: txData.paid_at,
      domain: txData.domain,
      customerCode: txData.customer?.customer_code,
      planId,
    };

    // 9. Record Immutable payment.verified Event with Concurrent P2002 Safety
    try {
      await prisma.paymentEvent.create({
        data: {
          userId,
          provider: "paystack",
          providerReference: reference,
          eventType: "payment.verified",
          status: "verified",
          amountMinor: txData.amount ?? 0,
          currency: txData.currency ?? "NGN",
          processedAt: new Date(),
          payload: JSON.stringify(sanitizedVerifiedPayload),
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

    // 10. Fulfil Subscription (Stage 4 Entitlement)
    const fulfilment = await fulfilSubscription({
      provider: "paystack",
      providerReference: reference,
    });

    return NextResponse.json(
      {
        received: true,
        success: true,
        fulfilled: fulfilment.success,
        reference,
        message: "Payment verified and recorded successfully.",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Paystack webhook error:", error);
    const message = error instanceof Error ? error.message : "Internal webhook error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
