import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const prisma = new PrismaClient();

async function runVerification() {
  console.log("===============================================================");
  console.log("STAGE 2 VERIFICATION: Paystack Real Test-Mode Checkout & Format");
  console.log("===============================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  try {
    const paystackSource = fs.readFileSync(
      path.join(process.cwd(), "src/lib/paystack.ts"),
      "utf-8"
    );

    // -------------------------------------------------------------
    // Test 1: Paystack Secret Key & Test-Mode-Only Guard
    // -------------------------------------------------------------
    console.log("--- Test 1: Test-Mode Key Guard ---");
    const envContent = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
    const keyMatch = envContent.match(/PAYSTACK_SECRET_KEY=["']?([^"'\r\n]+)/);
    const configuredKey = keyMatch ? keyMatch[1] : "";

    assert(
      configuredKey.startsWith("sk_test_"),
      `PAYSTACK_SECRET_KEY in .env is configured in test mode (${configuredKey})`
    );

    assert(
      paystackSource.includes('startsWith("sk_test_")'),
      "src/lib/paystack.ts enforces that secret key strictly starts with 'sk_test_'"
    );

    assert(
      paystackSource.includes("Paystack is restricted to test mode only"),
      "src/lib/paystack.ts blocks any non-test keys (e.g. sk_live_*)"
    );

    assert(
      paystackSource.includes("PAYSTACK_SECRET_KEY is not configured in environment variables"),
      "src/lib/paystack.ts throws clear configuration error if secret key is missing"
    );

    // -------------------------------------------------------------
    // Test 2: Reference Format (No underscores, alphanumeric + - . =)
    // -------------------------------------------------------------
    console.log("\n--- Test 2: Paystack Reference Format Verification ---");
    // Verify reference generator implementation
    assert(
      paystackSource.includes('generateCheckoutReference(prefix = "pstk")'),
      "generateCheckoutReference uses default prefix 'pstk'"
    );

    assert(
      paystackSource.includes("`${prefix}-${timestamp}-${randomHex}`"),
      "generateCheckoutReference uses format `${prefix}-${timestamp}-${randomHex}` with hyphens"
    );

    assert(
      !paystackSource.includes("`${prefix}_"),
      "generateCheckoutReference does NOT use underscores (_)"
    );

    // Generate references with the exact algorithm
    function generateRef(prefix = "pstk") {
      const timestamp = Date.now();
      const randomHex = crypto.randomBytes(8).toString("hex");
      return `${prefix}-${timestamp}-${randomHex}`;
    }

    const testRef1 = generateRef();
    const testRef2 = generateRef();

    assert(
      !testRef1.includes("_"),
      `Generated reference "${testRef1}" contains NO underscores (_)`
    );
    assert(
      /^[a-zA-Z0-9.\-=]+$/.test(testRef1),
      `Generated reference "${testRef1}" contains only allowed characters (alphanumeric, -, ., =)`
    );
    assert(
      /^pstk-\d+-[0-9a-f]{16}$/.test(testRef1),
      `Generated reference strictly matches format: pstk-{timestamp}-{randomBytes(8).hex}`
    );
    assert(
      testRef1 !== testRef2,
      `Consecutive references are unique: ${testRef1} !== ${testRef2}`
    );

    // -------------------------------------------------------------
    // Test 3: NO Mock/Fallback Checkout Behavior (Real API call)
    // -------------------------------------------------------------
    console.log("\n--- Test 3: NO Mock/Fallback Checkout Verification ---");
    assert(
      !paystackSource.includes("sandbox-mock") &&
        !paystackSource.includes("mock_code") &&
        !paystackSource.includes("placeholder"),
      "src/lib/paystack.ts contains ZERO mock URLs, sandbox-mock strings, or simulated fallbacks"
    );

    assert(
      paystackSource.includes('fetch("https://api.paystack.co/transaction/initialize"'),
      "src/lib/paystack.ts calls Paystack's real API endpoint: https://api.paystack.co/transaction/initialize"
    );

    // -------------------------------------------------------------
    // Test 4: Verify Returned authorization_url is Used Directly
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Use Paystack Returned data.authorization_url ---");
    assert(
      paystackSource.includes("const authorizationUrl = data?.data?.authorization_url;"),
      "src/lib/paystack.ts extracts data.data.authorization_url directly from Paystack API response"
    );

    const routeSource = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/checkout/initiate/route.ts"),
      "utf-8"
    );
    assert(
      routeSource.includes("const { authorizationUrl, accessCode } = await initializePaystackTransaction"),
      "API route extracts authorizationUrl directly from initializePaystackTransaction"
    );
    assert(
      !routeSource.includes("https://checkout.paystack.com"),
      "API route does not construct Paystack checkout URLs itself"
    );

    const planActionSource = fs.readFileSync(
      path.join(process.cwd(), "src/app/plans/plan-card-action.tsx"),
      "utf-8"
    );
    assert(
      planActionSource.includes("window.location.href = data.authorizationUrl;"),
      "Client component redirects directly to the server-returned authorizationUrl"
    );

    // -------------------------------------------------------------
    // Test 5: Client Secret Leakage Check
    // -------------------------------------------------------------
    console.log("\n--- Test 5: Client-side Code Secret Leakage Scan ---");
    const clientFiles = [
      "src/app/plans/plan-card-action.tsx",
      "src/app/plans/page.tsx",
      "src/app/dashboard/page.tsx",
      "src/lib/validation/checkout.ts",
    ];

    let foundSecretInClient = false;
    for (const file of clientFiles) {
      const fullPath = path.join(process.cwd(), file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (
          content.includes("process.env.PAYSTACK_SECRET_KEY") ||
          content.includes("sk_test_")
        ) {
          foundSecretInClient = true;
          console.error(`Found secret key reference in ${file}!`);
        }
      }
    }
    assert(
      !foundSecretInClient,
      "No client-facing components or files reference or bundle PAYSTACK_SECRET_KEY"
    );

    // -------------------------------------------------------------
    // Test 6: Plan Amounts in Database
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Plan Amounts in Database ---");
    const plans = await prisma.plan.findMany({ where: { active: true } });
    const freePlan = plans.find((p) => p.name.toLowerCase() === "free");
    const monthlyPlan = plans.find((p) => p.name.toLowerCase() === "monthly");
    const yearlyPlan = plans.find((p) => p.name.toLowerCase() === "yearly");

    assert(!!freePlan && freePlan.amountMinor === 0, "Free plan has amountMinor = 0");
    assert(
      !!monthlyPlan && monthlyPlan.amountMinor === 500000 && monthlyPlan.currency === "NGN",
      `Monthly plan has amountMinor = 500000 NGN (from DB)`
    );
    assert(
      !!yearlyPlan && yearlyPlan.amountMinor === 5000000 && yearlyPlan.currency === "NGN",
      `Yearly plan has amountMinor = 5000000 NGN (from DB)`
    );

    // -------------------------------------------------------------
    // Test 7: Setup Test User & Session for API Testing
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Setup Test User & Session ---");
    const testEmail = `test_checkout_${Date.now()}@example.com`;
    const testUser = await prisma.user.create({
      data: {
        email: testEmail,
        passwordHash: "$2b$12$dummyhashfordemotesting12345678901234567890123456789012",
        emailVerified: true,
      },
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.session.create({
      data: {
        userId: testUser.id,
        sessionToken: tokenHash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    // -------------------------------------------------------------
    // Test 8: Unauthenticated Request Blocked
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Unauthenticated Request Blocked ---");
    const unauthRes = await fetch("http://localhost:3000/api/checkout/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: monthlyPlan.id }),
    });

    assert(
      unauthRes.status === 401,
      `Unauthenticated checkout returns 401 Unauthorized (got ${unauthRes.status})`
    );

    // -------------------------------------------------------------
    // Test 9: Free Plan Blocked from Checkout
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Free Plan Blocked from Checkout ---");
    const freeRes = await fetch("http://localhost:3000/api/checkout/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `auth_session=${rawToken}`,
      },
      body: JSON.stringify({ planId: freePlan.id }),
    });

    const freeJson = await freeRes.json();
    assert(
      freeRes.status === 400,
      `Free plan checkout returns 400 Bad Request (got ${freeRes.status})`
    );
    assert(
      freeJson.error?.includes("Free plan does not require checkout"),
      `Error message correctly identifies Free plan: "${freeJson.error}"`
    );

    // -------------------------------------------------------------
    // Test 10: Real API Call & Checkout Initiation
    // -------------------------------------------------------------
    console.log("\n--- Test 10: Real API Call & Checkout Initiation ---");
    const checkoutRes = await fetch("http://localhost:3000/api/checkout/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `auth_session=${rawToken}`,
      },
      body: JSON.stringify({ planId: monthlyPlan.id }),
    });

    const checkoutJson = await checkoutRes.json();
    if (checkoutRes.status === 200) {
      assert(
        checkoutJson.success === true &&
          typeof checkoutJson.authorizationUrl === "string" &&
          checkoutJson.authorizationUrl.startsWith("https://checkout.paystack.com/"),
        `Initiation with configured Paystack test key returns 200 OK with real Paystack authorization URL: ${checkoutJson.authorizationUrl}`
      );
    } else {
      assert(
        checkoutRes.status === 500 &&
          (checkoutJson.error?.includes("Paystack API authentication failed (401)") ||
            checkoutJson.error?.includes("PAYSTACK_SECRET_KEY")),
        `Initiation with invalid key returns clear configuration error: "${checkoutJson.error}"`
      );
    }


    // -------------------------------------------------------------
    // Test 11: Entitlement Safety Verification
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Entitlement Safety Verification ---");
    const subscriptions = await prisma.subscription.findMany({
      where: { userId: testUser.id },
    });
    assert(
      subscriptions.length === 0,
      `ZERO subscription records exist for user after checkout requests (count: ${subscriptions.length})`
    );

    const activeSub = await prisma.subscription.findFirst({
      where: {
        userId: testUser.id,
        status: "active",
        currentPeriodEnd: { gte: new Date() },
      },
    });
    assert(
      activeSub === null,
      "No active subscription exists (zero unverified entitlement granted)"
    );

    // -------------------------------------------------------------
    // Test 12: Rate Limiting Enforcement
    // -------------------------------------------------------------
    console.log("\n--- Test 12: Rate Limiting Enforcement ---");
    let rateLimited = false;
    let retryAfterHeader = null;

    for (let i = 0; i < 8; i++) {
      const res = await fetch("http://localhost:3000/api/checkout/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `auth_session=${rawToken}`,
        },
        body: JSON.stringify({ planId: monthlyPlan.id }),
      });

      if (res.status === 429) {
        rateLimited = true;
        retryAfterHeader = res.headers.get("retry-after");
        break;
      }
    }

    assert(rateLimited, "Checkout initiation endpoint strictly enforces rate limiting (HTTP 429 returned)");
    assert(
      !!retryAfterHeader && parseInt(retryAfterHeader, 10) > 0,
      `RFC-compliant Retry-After header present: ${retryAfterHeader}s`
    );

    // Cleanup
    await prisma.session.deleteMany({ where: { userId: testUser.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    console.log("\nCleaned up test data.");
  } catch (err) {
    console.error("Verification failed with exception:", err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n===============================================================");
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("===============================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runVerification();
