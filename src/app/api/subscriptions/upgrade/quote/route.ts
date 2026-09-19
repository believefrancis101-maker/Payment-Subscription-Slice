import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import { upgradeQuoteSchema } from "@/lib/validation/checkout";
import { getUpgradeQuote, UpgradeEligibilityError } from "@/lib/upgrades";

const QUOTE_IP_LIMIT = { limit: 15, windowSeconds: 60 };
const QUOTE_USER_LIMIT = { limit: 10, windowSeconds: 60 };

export async function POST(request: NextRequest) {
  try {
    // 1. IP-level Rate Limiting
    const ip = getClientIp(request);
    const ipCheck = checkRateLimit(`upgrade:quote:ip:${ip}`, QUOTE_IP_LIMIT);
    if (!ipCheck.success) {
      return rateLimitExceededResponse(
        `Too many upgrade quote requests from this IP. Please wait ${ipCheck.retryAfter} seconds before trying again.`,
        ipCheck
      );
    }

    // 2. Authentication Check
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized. You must be signed in to request an upgrade quote." },
        { status: 401 }
      );
    }

    // 2b. User-level Rate Limiting
    const userCheck = checkRateLimit(
      `upgrade:quote:user:${user.id}`,
      QUOTE_USER_LIMIT
    );
    if (!userCheck.success) {
      return rateLimitExceededResponse(
        `Too many upgrade quote requests for your account. Please wait ${userCheck.retryAfter} seconds before trying again.`,
        userCheck
      );
    }

    // 3. Request Validation (target plan optional; defaults to active Yearly)
    const body = await request.json().catch(() => null);
    const validation = upgradeQuoteSchema.safeParse(body ?? {});
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

    // 4. Server-side eligibility + proration (nothing persisted by a quote)
    const quote = await getUpgradeQuote(user.id, toPlanId);

    return NextResponse.json({ success: true, ...quote }, { status: 200 });
  } catch (error) {
    if (error instanceof UpgradeEligibilityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Upgrade quote error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to compute upgrade quote.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}