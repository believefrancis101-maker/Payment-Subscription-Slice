import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import { subscriptionCancelSchema } from "@/lib/validation/checkout";
import {
  scheduleCancellation,
  CancellationEligibilityError,
} from "@/lib/cancellations";

const CANCEL_IP_LIMIT = { limit: 15, windowSeconds: 60 };
const CANCEL_USER_LIMIT = { limit: 10, windowSeconds: 60 };

export async function POST(request: NextRequest) {
  try {
    // 1. IP Rate Limiting
    const ip = getClientIp(request);
    const ipCheck = checkRateLimit(`cancel:ip:${ip}`, CANCEL_IP_LIMIT);
    if (!ipCheck.success) {
      return rateLimitExceededResponse(
        `Too many cancellation attempts from this IP. Please wait ${ipCheck.retryAfter} seconds before trying again.`,
        ipCheck
      );
    }

    // 2. Authentication Check
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized. You must be signed in to cancel your subscription." },
        { status: 401 }
      );
    }

    // 2b. User Rate Limiting
    const userCheck = checkRateLimit(
      `cancel:user:${user.id}`,
      CANCEL_USER_LIMIT
    );
    if (!userCheck.success) {
      return rateLimitExceededResponse(
        `Too many cancellation requests for your account. Please wait ${userCheck.retryAfter} seconds before trying again.`,
        userCheck
      );
    }

    // 3. Request Body Validation
    const body = await request.json().catch(() => ({}));
    const validation = subscriptionCancelSchema.safeParse(body ?? {});
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed.",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { reason } = validation.data;

    // 4. Server-controlled cancellation scheduling
    const result = await scheduleCancellation(user.id, reason);

    // 5. Response
    return NextResponse.json(
      {
        success: true,
        idempotent: result.idempotent,
        subscription: {
          id: result.subscription.id,
          planId: result.subscription.planId,
          status: result.subscription.status,
          cancelAtPeriodEnd: result.subscription.cancelAtPeriodEnd,
          cancelledAt: result.subscription.cancelledAt
            ? result.subscription.cancelledAt.toISOString()
            : null,
          currentPeriodEnd:
            result.subscription.currentPeriodEnd.toISOString(),
          cancellationReason: result.subscription.cancellationReason,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof CancellationEligibilityError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("Subscription cancellation error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to cancel subscription.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
