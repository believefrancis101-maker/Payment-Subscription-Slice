import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import { downgradeInitiateSchema } from "@/lib/validation/checkout";
import {
  scheduleDowngrade,
  DowngradeEligibilityError,
} from "@/lib/downgrades";

const DOWNGRADE_IP_LIMIT = { limit: 15, windowSeconds: 60 };
const DOWNGRADE_USER_LIMIT = { limit: 10, windowSeconds: 60 };

export async function POST(request: NextRequest) {
  try {
    // 1. IP-level Rate Limiting
    const ip = getClientIp(request);
    const ipCheck = checkRateLimit(
      `downgrade:initiate:ip:${ip}`,
      DOWNGRADE_IP_LIMIT
    );

    if (!ipCheck.success) {
      return rateLimitExceededResponse(
        `Too many downgrade requests from this IP. Please wait ${ipCheck.retryAfter} seconds before trying again.`,
        ipCheck
      );
    }

    // 2. Authentication Check
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json(
        {
          error:
            "Unauthorized. You must be signed in to schedule a downgrade.",
        },
        { status: 401 }
      );
    }

    // 2b. User-level Rate Limiting
    const userCheck = checkRateLimit(
      `downgrade:initiate:user:${user.id}`,
      DOWNGRADE_USER_LIMIT
    );

    if (!userCheck.success) {
      return rateLimitExceededResponse(
        `Too many downgrade requests for your account. Please wait ${userCheck.retryAfter} seconds before trying again.`,
        userCheck
      );
    }

    // 3. Request Validation
    const body = await request.json().catch(() => null);
    const validation = downgradeInitiateSchema.safeParse(body ?? {});

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed.",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { toPlanId } = validation.data;

    // 4. Fully server-controlled downgrade scheduling.
    //    The active Monthly plan is resolved from the database.
    //    toPlanId is treated only as an optional assertion.
    //    No payment is initialized and the current Yearly subscription
    //    remains unchanged until its current period ends.
    const result = await scheduleDowngrade({
      userId: user.id,
      toPlanId,
    });

    // 5. Return the scheduled change.
    return NextResponse.json(
      {
        success: true,
        idempotent: result.idempotent ?? false,
        change: {
          id: result.change.id,
          type: result.change.changeType,
          status: result.change.status,
          effectiveAt: result.change.effectiveAt.toISOString(),
        },
        subscription: {
          id: result.subscription.id,
          planId: result.subscription.planId,
          currentPeriodStart:
            result.subscription.currentPeriodStart.toISOString(),
          currentPeriodEnd:
            result.subscription.currentPeriodEnd.toISOString(),
        },
        fromPlan: {
          id: result.fromPlan.id,
          name: result.fromPlan.name,
          interval: result.fromPlan.interval,
        },
        toPlan: {
          id: result.toPlan.id,
          name: result.toPlan.name,
          interval: result.toPlan.interval,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof DowngradeEligibilityError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("Downgrade scheduling error:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Failed to schedule subscription downgrade.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}