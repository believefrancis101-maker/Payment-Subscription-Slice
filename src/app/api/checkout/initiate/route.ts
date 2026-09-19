import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import { checkoutInitiateSchema } from "@/lib/validation/checkout";
import {
  generateCheckoutReference,
  initializePaystackTransaction,
} from "@/lib/paystack";

// Rate limits for checkout initiation
const CHECKOUT_IP_LIMIT = { limit: 10, windowSeconds: 60 };
const CHECKOUT_USER_LIMIT = { limit: 5, windowSeconds: 60 };

// Only Monthly and Yearly plans can enter the payment checkout flow
const ALLOWED_CHECKOUT_PLANS = ["monthly", "yearly"];

export async function POST(request: NextRequest) {
  try {
    // 1. IP-level Rate Limiting
    const ip = getClientIp(request);
    const ipCheck = checkRateLimit(`checkout:ip:${ip}`, CHECKOUT_IP_LIMIT);
    if (!ipCheck.success) {
      return rateLimitExceededResponse(
        `Too many checkout attempts from this IP. Please wait ${ipCheck.retryAfter} seconds before trying again.`,
        ipCheck
      );
    }

    // 2. Authentication Check
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized. You must be signed in to initiate checkout." },
        { status: 401 }
      );
    }

    // 3. User-level Rate Limiting
    const userCheck = checkRateLimit(`checkout:user:${user.id}`, CHECKOUT_USER_LIMIT);
    if (!userCheck.success) {
      return rateLimitExceededResponse(
        `Too many checkout attempts for your account. Please wait ${userCheck.retryAfter} seconds before trying again.`,
        userCheck
      );
    }

    // 4. Request Validation
    const body = await request.json().catch(() => null);
    const validation = checkoutInitiateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed.",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { planId } = validation.data;

    // 5. Plan Lookup & Eligibility Check (using stored DB values)
    const plan = await prisma.plan.findUnique({
      where: { id: planId },
    });

    if (!plan || !plan.active) {
      return NextResponse.json(
        { error: "The requested subscription plan was not found or is inactive." },
        { status: 404 }
      );
    }

    const normalizedPlanName = plan.name.trim().toLowerCase();

    // Prevent Free plan from checkout initiation
    if (normalizedPlanName === "free" || plan.amountMinor <= 0) {
      return NextResponse.json(
        { error: "The Free plan does not require checkout initiation." },
        { status: 400 }
      );
    }

    // Only allow Monthly and Yearly
    if (!ALLOWED_CHECKOUT_PLANS.includes(normalizedPlanName)) {
      return NextResponse.json(
        {
          error: `Checkout is only available for Monthly and Yearly plans. Received: ${plan.name}`,
        },
        { status: 400 }
      );
    }

    // 5b. Active Subscription Protection (Stage 4 constraint: No upgrades/replacements)
    const existingActiveSubscription = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        status: "active",
        currentPeriodStart: { lte: new Date() },
        currentPeriodEnd: { gte: new Date() },
      },
      include: { plan: true },
    });

    if (existingActiveSubscription && existingActiveSubscription.plan.amountMinor > 0) {
      return NextResponse.json(
        {
          error:
            "You already have an active subscription. Subscription changes and upgrades are not supported at this stage.",
        },
        { status: 409 }
      );
    }

    // 6. Generate Unique Provider Reference
    const reference = generateCheckoutReference();

    // 7. Determine Callback URL
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const callbackUrl = `${appUrl}/plans?checkout_status=completed&reference=${encodeURIComponent(
      reference
    )}`;

    // 8. Initialize Paystack Hosted Transaction (amounts strictly from DB)
    const { authorizationUrl, accessCode } = await initializePaystackTransaction({
      email: user.email,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      reference,
      callbackUrl,
      metadata: {
        userId: user.id,
        planId: plan.id,
        planName: plan.name,
        interval: plan.interval,
      },
    });

    // 9. Persist Audit Payment Event (NO subscription or entitlement granted)
    await prisma.paymentEvent.create({
      data: {
        userId: user.id,
        provider: "paystack",
        providerReference: reference,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        payload: JSON.stringify({
          planId: plan.id,
          planName: plan.name,
          interval: plan.interval,
          accessCode,
        }),
      },
    });

    // 10. Return Authorization URL for Client-side Redirect
    return NextResponse.json(
      {
        success: true,
        authorizationUrl,
        reference,
        accessCode,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Checkout initiation error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to initiate checkout.";

    return NextResponse.json(
      {
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
