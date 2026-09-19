import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import { upgradeInitiateSchema } from "@/lib/validation/checkout";
import { initiateUpgradeCheckout, UpgradeEligibilityError } from "@/lib/upgrades";

const UPGRADE_IP_LIMIT = { limit: 15, windowSeconds: 60 };
const UPGRADE_USER_LIMIT = { limit: 10, windowSeconds: 60 };

export async function POST(request: NextRequest) {
  try {
    // 1. IP-level Rate Limiting
    const ip = getClientIp(request);
    const ipCheck = checkRateLimit(`upgrade:initiate:ip:${ip}`, UPGRADE_IP_LIMIT);
    if (!ipCheck.success) {
      return rateLimitExceededResponse(
        `Too many upgrade checkout attempts from this IP. Please wait ${ipCheck.retryAfter} seconds before trying again.`,
        ipCheck
      );
    }

    // 2. Authentication Check
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized. You must be signed in to confirm an upgrade." },
        { status: 401 }
      );
    }

    // 2b. User-level Rate Limiting
    const userCheck = checkRateLimit(
      `upgrade:initiate:user:${user.id}`,
      UPGRADE_USER_LIMIT
    );
    if (!userCheck.success) {
      return rateLimitExceededResponse(
        `Too many upgrade checkout attempts for your account. Please wait ${userCheck.retryAfter} seconds before trying again.`,
        userCheck
      );
    }

    // 3. Request Validation
    const body = await request.json().catch(() => null);
    const validation = upgradeInitiateSchema.safeParse(body ?? {});
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

    // 4. Fully server-controlled initiation. The active Yearly plan is
    //    resolved from the database; toPlanId (if supplied by the client) is
    //    treated only as an assertion. Every amount is derived server-side
    //    and never trusted from the request body. A database-atomic claim on
    //    the subscription guarantees only one pending upgrade checkout (and
    //    therefore one Paystack reference) can exist at a time.
    const result = await initiateUpgradeCheckout({
      userId: user.id,
      email: user.email,
      toPlanId,
    });

    // 5. Return the (possibly pre-existing) authorization URL. Duplicate /
    //    concurrent requests converge on the same pending attempt. The
    //    Subscription itself is untouched until a verified payment arrives.
    return NextResponse.json(
      {
        success: true,
        authorizationUrl: result.authorizationUrl,
        reference: result.reference,
        accessCode: result.accessCode,
        changeId: result.changeId,
        subscriptionId: result.subscriptionId,
        chargeMinor: result.proration.chargeMinor,
        creditMinor: result.proration.creditMinor,
        daysRemaining: result.proration.daysRemaining,
        targetPlan: result.toPlan,
        duplicate: result.kind === "existing",
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof UpgradeEligibilityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Upgrade checkout initiation error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to initiate upgrade checkout.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}