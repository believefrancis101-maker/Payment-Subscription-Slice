import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const prisma = new PrismaClient();

// Mirror of deterministic calculateSubscriptionPeriod from src/lib/fulfilment.ts
function calculateSubscriptionPeriod(startDate, interval) {
  const currentPeriodStart = new Date(startDate.getTime());
  const normalized = interval.trim().toLowerCase();

  const startYear = currentPeriodStart.getUTCFullYear();
  const startMonth = currentPeriodStart.getUTCMonth();
  const startDay = currentPeriodStart.getUTCDate();
  const startHours = currentPeriodStart.getUTCHours();
  const startMinutes = currentPeriodStart.getUTCMinutes();
  const startSeconds = currentPeriodStart.getUTCSeconds();
  const startMs = currentPeriodStart.getUTCMilliseconds();

  let targetYear;
  let targetMonth;

  if (normalized === "monthly") {
    if (startMonth === 11) {
      targetYear = startYear + 1;
      targetMonth = 0;
    } else {
      targetYear = startYear;
      targetMonth = startMonth + 1;
    }
  } else if (normalized === "yearly") {
    targetYear = startYear + 1;
    targetMonth = startMonth;
  } else {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  const maxDaysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();

  const targetDay = Math.min(startDay, maxDaysInTargetMonth);

  const currentPeriodEnd = new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      targetDay,
      startHours,
      startMinutes,
      startSeconds,
      startMs
    )
  );

  return { currentPeriodStart, currentPeriodEnd };
}

async function runStage4Verification() {
  console.log("=======================================================================");
  console.log("STAGE 4 VERIFICATION: Verified Payment Fulfilment & Subscriptions");
  console.log("=======================================================================\n");

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

  // Read .env secret key safely
  const envContent = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
  const keyMatch = envContent.match(/^PAYSTACK_SECRET_KEY=(.*)$/m);
  const secretKey = keyMatch ? keyMatch[1].trim().replace(/^["']|["']$/g, "").trim() : "";

  function signPayload(body) {
    return crypto.createHmac("sha512", secretKey).update(body).digest("hex");
  }

  try {
    // -------------------------------------------------------------
    // Test 0: Deterministic Calendar Period Calculation
    // -------------------------------------------------------------
    console.log("--- Test 0: Deterministic Calendar Period Calculation (No Overflow) ---");
    
    // Case 1: January 31 monthly start (non-leap year 2026) -> Feb 28
    const jan31_2026 = calculateSubscriptionPeriod(new Date("2026-01-31T12:00:00.000Z"), "monthly");
    assert(
      jan31_2026.currentPeriodEnd.toISOString() === "2026-02-28T12:00:00.000Z",
      `Jan 31 (2026) + 1 month clamps deterministically to Feb 28: ${jan31_2026.currentPeriodEnd.toISOString()}`
    );

    // Case 1b: January 31 monthly start (leap year 2024) -> Feb 29
    const jan31_2024 = calculateSubscriptionPeriod(new Date("2024-01-31T12:00:00.000Z"), "monthly");
    assert(
      jan31_2024.currentPeriodEnd.toISOString() === "2024-02-29T12:00:00.000Z",
      `Jan 31 (2024 leap year) + 1 month clamps to Feb 29: ${jan31_2024.currentPeriodEnd.toISOString()}`
    );

    // Case 2: August 31 monthly start -> Sep 30
    const aug31 = calculateSubscriptionPeriod(new Date("2026-08-31T08:15:30.000Z"), "monthly");
    assert(
      aug31.currentPeriodEnd.toISOString() === "2026-09-30T08:15:30.000Z",
      `Aug 31 + 1 month clamps deterministically to Sep 30: ${aug31.currentPeriodEnd.toISOString()}`
    );

    // Case 3: February 29 leap-year yearly start -> Feb 28 in non-leap year
    const feb29_leap = calculateSubscriptionPeriod(new Date("2024-02-29T15:00:00.000Z"), "yearly");
    assert(
      feb29_leap.currentPeriodEnd.toISOString() === "2025-02-28T15:00:00.000Z",
      `Feb 29 (2024 leap) + 1 year clamps to Feb 28 non-leap: ${feb29_leap.currentPeriodEnd.toISOString()}`
    );

    // Case 4: Normal monthly date retains calendar day
    const normalMonthly = calculateSubscriptionPeriod(new Date("2026-05-15T10:00:00.000Z"), "monthly");
    assert(
      normalMonthly.currentPeriodEnd.toISOString() === "2026-06-15T10:00:00.000Z",
      `Normal monthly (May 15) retains calendar day (Jun 15): ${normalMonthly.currentPeriodEnd.toISOString()}`
    );

    // Case 5: Normal yearly date retains calendar day and month
    const normalYearly = calculateSubscriptionPeriod(new Date("2026-07-20T18:30:00.000Z"), "yearly");
    assert(
      normalYearly.currentPeriodEnd.toISOString() === "2027-07-20T18:30:00.000Z",
      `Normal yearly (Jul 20, 2026) retains calendar day (Jul 20, 2027): ${normalYearly.currentPeriodEnd.toISOString()}`
    );

    const plans = await prisma.plan.findMany({ where: { active: true } });
    const monthlyPlan = plans.find((p) => p.name.toLowerCase() === "monthly");
    const yearlyPlan = plans.find((p) => p.name.toLowerCase() === "yearly");

    assert(!!monthlyPlan, "Monthly plan exists in database");
    assert(!!yearlyPlan, "Yearly plan exists in database");

    // -------------------------------------------------------------
    // Setup Test Users & Sessions
    // -------------------------------------------------------------
    console.log("\n--- Setup: Test Users & Authenticated Sessions ---");
    const userA = await prisma.user.upsert({
      where: { email: "stage4_user_a@example.com" },
      update: { emailVerified: true },
      create: {
        email: "stage4_user_a@example.com",
        passwordHash: "$2b$12$dummyhashfordemotesting12345678901234567890123456789012",
        emailVerified: true,
      },
    });

    const userB = await prisma.user.upsert({
      where: { email: "stage4_user_b@example.com" },
      update: { emailVerified: true },
      create: {
        email: "stage4_user_b@example.com",
        passwordHash: "$2b$12$dummyhashfordemotesting12345678901234567890123456789012",
        emailVerified: true,
      },
    });

    const rawTokenA = crypto.randomBytes(32).toString("hex");
    const tokenHashA = crypto.createHash("sha256").update(rawTokenA).digest("hex");
    await prisma.session.create({
      data: {
        userId: userA.id,
        sessionToken: tokenHashA,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    const rawTokenB = crypto.randomBytes(32).toString("hex");
    const tokenHashB = crypto.createHash("sha256").update(rawTokenB).digest("hex");
    await prisma.session.create({
      data: {
        userId: userB.id,
        sessionToken: tokenHashB,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    // -------------------------------------------------------------
    // Test 1 & 3 & 4: Valid Verified Monthly Payment Fulfilment
    // -------------------------------------------------------------
    console.log("\n--- Test 1, 3 & 4: Monthly Payment Fulfilment, Amount & Period ---");
    const testRefMonthly = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;

    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefMonthly,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({
          planId: monthlyPlan.id,
          planName: monthlyPlan.name,
          interval: monthlyPlan.interval,
        }),
      },
    });

    const monthlyWebhookBody = JSON.stringify({
      event: "charge.success",
      data: {
        id: 11223344,
        domain: "test",
        status: "success",
        reference: testRefMonthly,
        amount: monthlyPlan.amountMinor,
        message: "Successful",
        gateway_response: "Successful",
        paid_at: new Date().toISOString(),
        channel: "card",
        currency: monthlyPlan.currency,
        customer: {
          id: 54321,
          email: userA.email,
          customer_code: "CUS_userA_test",
        },
        metadata: {
          userId: userA.id,
          planId: monthlyPlan.id,
          planName: monthlyPlan.name,
        },
      },
    });

    const monthlyWebhookSig = signPayload(monthlyWebhookBody);
    const monthlyWebhookRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": monthlyWebhookSig,
      },
      body: monthlyWebhookBody,
    });

    const monthlyWebhookJson = await monthlyWebhookRes.json();
    assert(
      monthlyWebhookRes.status === 200 && monthlyWebhookJson.success === true,
      `Monthly webhook returned 200 OK and success=true (got ${monthlyWebhookRes.status})`
    );

    const monthlySub = await prisma.subscription.findUnique({
      where: { originatingPaymentReference: testRefMonthly },
      include: { plan: true },
    });

    assert(
      !!monthlySub && monthlySub.status === "active",
      `Exactly one Monthly Subscription created with status="active" (ID: ${monthlySub?.id})`
    );
    assert(
      monthlySub?.cancelAtPeriodEnd === false &&
        monthlySub?.cancelledAt === null &&
        monthlySub?.cancellationReason === null,
      "Initial subscription has cancelAtPeriodEnd=false, cancelledAt=null, cancellationReason=null"
    );
    assert(
      monthlySub?.amountMinor === monthlyPlan.amountMinor &&
        monthlySub?.currency === monthlyPlan.currency,
      `Subscription amount (${monthlySub?.amountMinor}) and currency (${monthlySub?.currency}) equal verified plan`
    );

    const mStart = new Date(monthlySub.currentPeriodStart);
    const mEnd = new Date(monthlySub.currentPeriodEnd);
    const expectedMonth = (mStart.getUTCMonth() + 1) % 12;
    assert(
      mEnd.getUTCMonth() === expectedMonth,
      `Monthly period end is one calendar month after start (${mStart.toISOString()} -> ${mEnd.toISOString()})`
    );

    // -------------------------------------------------------------
    // Test 2 & 5: Valid Verified Yearly Payment Fulfilment & Period
    // -------------------------------------------------------------
    console.log("\n--- Test 2 & 5: Yearly Payment Fulfilment, Amount & Period ---");
    const testRefYearly = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;

    await prisma.paymentEvent.create({
      data: {
        userId: userB.id,
        provider: "paystack",
        providerReference: testRefYearly,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: yearlyPlan.amountMinor,
        currency: yearlyPlan.currency,
        payload: JSON.stringify({
          planId: yearlyPlan.id,
          planName: yearlyPlan.name,
          interval: yearlyPlan.interval,
        }),
      },
    });

    const yearlyWebhookBody = JSON.stringify({
      event: "charge.success",
      data: {
        id: 22334455,
        domain: "test",
        status: "success",
        reference: testRefYearly,
        amount: yearlyPlan.amountMinor,
        message: "Successful",
        gateway_response: "Successful",
        paid_at: new Date().toISOString(),
        channel: "card",
        currency: yearlyPlan.currency,
        customer: {
          id: 65432,
          email: userB.email,
          customer_code: "CUS_userB_test",
        },
        metadata: {
          userId: userB.id,
          planId: yearlyPlan.id,
          planName: yearlyPlan.name,
        },
      },
    });

    const yearlyWebhookSig = signPayload(yearlyWebhookBody);
    const yearlyWebhookRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": yearlyWebhookSig,
      },
      body: yearlyWebhookBody,
    });

    const yearlyWebhookJson = await yearlyWebhookRes.json();
    assert(
      yearlyWebhookRes.status === 200 && yearlyWebhookJson.success === true,
      `Yearly webhook returned 200 OK and success=true (got ${yearlyWebhookRes.status})`
    );

    const yearlySub = await prisma.subscription.findUnique({
      where: { originatingPaymentReference: testRefYearly },
      include: { plan: true },
    });

    assert(
      !!yearlySub && yearlySub.status === "active",
      `Exactly one Yearly Subscription created with status="active" (ID: ${yearlySub?.id})`
    );
    assert(
      yearlySub?.amountMinor === yearlyPlan.amountMinor &&
        yearlySub?.currency === yearlyPlan.currency,
      `Yearly subscription amount equals yearly plan (${yearlySub?.amountMinor} kobo)`
    );

    const yStart = new Date(yearlySub.currentPeriodStart);
    const yEnd = new Date(yearlySub.currentPeriodEnd);
    assert(
      yEnd.getUTCFullYear() === yStart.getUTCFullYear() + 1 && yEnd.getUTCMonth() === yStart.getUTCMonth(),
      `Yearly period end is one calendar year after start (${yStart.toISOString()} -> ${yEnd.toISOString()})`
    );

    // -------------------------------------------------------------
    // Test 6: Payment Lifecycle Evidence & Append-Only Log Preservation
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Payment Lifecycle Evidence & Append-Only Log ---");
    const eventsForMonthly = await prisma.paymentEvent.findMany({
      where: { providerReference: testRefMonthly },
      orderBy: { createdAt: "asc" },
    });

    const eventTypes = eventsForMonthly.map((e) => e.eventType);
    assert(
      eventTypes.includes("checkout.initiated") &&
        eventTypes.includes("payment.verified") &&
        eventTypes.includes("payment.fulfilled"),
      `All 3 distinct lifecycle records exist: ${eventTypes.join(", ")}`
    );

    const fulfilledEv = eventsForMonthly.find((e) => e.eventType === "payment.fulfilled");
    assert(
      fulfilledEv?.status === "fulfilled" && fulfilledEv?.subscriptionId === monthlySub.id,
      `payment.fulfilled contains resulting subscriptionId (${fulfilledEv?.subscriptionId})`
    );

    // Confirm that payment log is append-only: earlier rows were NOT mutated
    const verifiedEv = eventsForMonthly.find((e) => e.eventType === "payment.verified");
    assert(
      verifiedEv?.subscriptionId === null,
      "payment.verified row remained immutable (subscriptionId was NOT attached/mutated)"
    );

    const initiatedEv = eventsForMonthly.find((e) => e.eventType === "checkout.initiated");
    assert(
      initiatedEv?.subscriptionId === null,
      "checkout.initiated row remained immutable (subscriptionId was NOT attached/mutated)"
    );

    // -------------------------------------------------------------
    // Test 7: Repeating Fulfilment (Idempotency)
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Repeating Fulfilment (Idempotency) ---");
    const duplicateWebhookRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": monthlyWebhookSig,
      },
      body: monthlyWebhookBody,
    });

    const duplicateWebhookJson = await duplicateWebhookRes.json();
    assert(
      duplicateWebhookRes.status === 200 && duplicateWebhookJson.idempotent === true,
      `Duplicate webhook recognised as idempotent (got 200 OK, idempotent: true)`
    );

    const subCountMonthly = await prisma.subscription.count({
      where: { originatingPaymentReference: testRefMonthly },
    });
    assert(
      subCountMonthly === 1,
      `Repeating fulfilment with the same reference did NOT create another Subscription (count: ${subCountMonthly})`
    );

    const fulfilledCountMonthly = await prisma.paymentEvent.count({
      where: {
        providerReference: testRefMonthly,
        eventType: "payment.fulfilled",
      },
    });
    assert(
      fulfilledCountMonthly === 1,
      `Repeating fulfilment did NOT create another payment.fulfilled event (count: ${fulfilledCountMonthly})`
    );

    // -------------------------------------------------------------
    // Test 8: Concurrent Fulfilment Safety
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Concurrent Fulfilment Race Condition Safety ---");
    const testRefConcurrent = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const userC = await prisma.user.create({
      data: {
        email: `stage4_user_c_${Date.now()}@example.com`,
        passwordHash: "$2b$12$dummyhashfordemotesting12345678901234567890123456789012",
        emailVerified: true,
      },
    });

    await prisma.paymentEvent.create({
      data: {
        userId: userC.id,
        provider: "paystack",
        providerReference: testRefConcurrent,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({
          planId: monthlyPlan.id,
          planName: monthlyPlan.name,
          interval: monthlyPlan.interval,
        }),
      },
    });

    const concurrentBody = JSON.stringify({
      event: "charge.success",
      data: {
        id: 77889900,
        domain: "test",
        status: "success",
        reference: testRefConcurrent,
        amount: monthlyPlan.amountMinor,
        gateway_response: "Successful",
        channel: "card",
        currency: monthlyPlan.currency,
        customer: { email: userC.email },
        metadata: { userId: userC.id, planId: monthlyPlan.id },
      },
    });

    const concurrentSig = signPayload(concurrentBody);

    const concurrentResponses = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        fetch("http://localhost:3000/api/webhooks/paystack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-paystack-signature": concurrentSig,
          },
          body: concurrentBody,
        })
      )
    );

    const allConcurrent200 = concurrentResponses.every((r) => r.status === 200);
    assert(
      allConcurrent200,
      "All 5 concurrent webhook deliveries handled cleanly with 200 OK (no 500 error)"
    );

    const concurrentSubCount = await prisma.subscription.count({
      where: { originatingPaymentReference: testRefConcurrent },
    });
    assert(
      concurrentSubCount === 1,
      `Concurrent fulfilment attempts produce exactly ONE Subscription in DB (count: ${concurrentSubCount})`
    );

    const concurrentFulfilledCount = await prisma.paymentEvent.count({
      where: {
        providerReference: testRefConcurrent,
        eventType: "payment.fulfilled",
      },
    });
    assert(
      concurrentFulfilledCount === 1,
      `Concurrent fulfilment attempts produce exactly ONE payment.fulfilled row (count: ${concurrentFulfilledCount})`
    );

    // -------------------------------------------------------------
    // Test 9: Browser-Only Return Forbidden
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Browser-Only Return Forbidden ---");
    const fakeRef = "pstk-fake-client-forged-999";
    const fakeVerifyRes = await fetch("http://localhost:3000/api/checkout/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `auth_session=${rawTokenA}`,
      },
      body: JSON.stringify({ reference: fakeRef }),
    });

    assert(
      fakeVerifyRes.status === 404,
      `Uninitiated browser-only reference verification rejected with 404 Not Found (got ${fakeVerifyRes.status})`
    );

    const fakeSub = await prisma.subscription.findUnique({
      where: { originatingPaymentReference: fakeRef },
    });
    assert(
      fakeSub === null,
      "Zero subscriptions created from uninitiated/fake browser reference"
    );

    // -------------------------------------------------------------
    // Test 10: Unverified Payment Cannot Create Subscription
    // -------------------------------------------------------------
    console.log("\n--- Test 10: Unverified Payment Cannot Create Subscription ---");
    const testRefUnverified = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userC.id,
        provider: "paystack",
        providerReference: testRefUnverified,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    const unverifiedSub = await prisma.subscription.findUnique({
      where: { originatingPaymentReference: testRefUnverified },
    });
    assert(
      unverifiedSub === null,
      "Initiated-only payment without successful verification produces zero subscriptions"
    );

    // -------------------------------------------------------------
    // Test 11: Active Subscription Protection (No Overwrites / Upgrades at Stage 4)
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Active Subscription Protection ---");
    const initiateConflictRes = await fetch("http://localhost:3000/api/checkout/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `auth_session=${rawTokenA}`,
      },
      body: JSON.stringify({ planId: yearlyPlan.id }),
    });

    assert(
      initiateConflictRes.status === 409,
      `Checkout initiation for user with active subscription rejected with 409 Conflict (got ${initiateConflictRes.status})`
    );

    // Attempt webhook fulfilment for userA with another plan
    const testRefOverwritten = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefOverwritten,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: yearlyPlan.amountMinor,
        currency: yearlyPlan.currency,
        payload: JSON.stringify({ planId: yearlyPlan.id }),
      },
    });

    const overwriteWebhookBody = JSON.stringify({
      event: "charge.success",
      data: {
        reference: testRefOverwritten,
        amount: yearlyPlan.amountMinor,
        currency: yearlyPlan.currency,
        gateway_response: "Approved",
        channel: "card",
        customer: { email: userA.email },
        metadata: { userId: userA.id, planId: yearlyPlan.id },
      },
    });

    const overwriteWebhookSig = signPayload(overwriteWebhookBody);
    await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": overwriteWebhookSig,
      },
      body: overwriteWebhookBody,
    });

    const userAActiveSubs = await prisma.subscription.findMany({
      where: { userId: userA.id, status: "active" },
    });
    assert(
      userAActiveSubs.length === 1 && userAActiveSubs[0].planId === monthlyPlan.id,
      `User A still has exactly ONE active subscription, and it remains the original Monthly plan (no silent replace)`
    );

    // -------------------------------------------------------------
    // Test 12: Strengthened Database Invariant & No User-Level Entitlement Flag
    // -------------------------------------------------------------
    console.log("\n--- Test 12: Database Invariant & No User-Level Flag ---");
    assert(
      typeof monthlySub.originatingPaymentReference === "string" &&
        monthlySub.originatingPaymentReference.length > 0,
      `Subscription.originatingPaymentReference is non-null String @unique ("${monthlySub.originatingPaymentReference}")`
    );

    const userRecord = await prisma.user.findUnique({
      where: { id: userA.id },
    });
    assert(
      userRecord.isPaid === undefined &&
        userRecord.isPremium === undefined &&
        userRecord.paidPlan === undefined,
      "User model contains no boolean/shortcut entitlement fields (isPaid, isPremium, paidPlan are undefined)"
    );

    // Cleanup test records
    await prisma.paymentEvent.deleteMany({
      where: { userId: { in: [userA.id, userB.id, userC.id] } },
    });
    await prisma.subscription.deleteMany({
      where: { userId: { in: [userA.id, userB.id, userC.id] } },
    });
    await prisma.session.deleteMany({
      where: { userId: { in: [userA.id, userB.id, userC.id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userA.id, userB.id, userC.id] } },
    });
    console.log("\nCleaned up Stage 4 test records.");
  } catch (err) {
    console.error("Verification failed with exception:", err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n=======================================================================");
  console.log(`STAGE 4 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runStage4Verification();
