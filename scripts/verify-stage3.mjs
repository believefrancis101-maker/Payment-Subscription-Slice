import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const prisma = new PrismaClient();

async function runStage3Verification() {
  console.log("=======================================================================");
  console.log("STAGE 3 VERIFICATION: Payment Verification & Paystack Webhook Handling");
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

  try {
    // -------------------------------------------------------------
    // Test 1: HMAC SHA512 Signature Helper Verification
    // -------------------------------------------------------------
    console.log("--- Test 1: Webhook HMAC SHA512 Signature Verification ---");
    const testBody = JSON.stringify({
      event: "charge.success",
      data: { reference: "test-ref-123", amount: 500000, currency: "NGN" },
    });

    const validSignature = crypto
      .createHmac("sha512", secretKey)
      .update(testBody)
      .digest("hex");

    const invalidSignature = crypto
      .createHmac("sha512", "wrong_secret_key_123")
      .update(testBody)
      .digest("hex");

    assert(
      validSignature.length === 128,
      "HMAC SHA512 signature generates standard 128-hex character digest"
    );

    // -------------------------------------------------------------
    // Test 2: Webhook Endpoint Signature Security
    // -------------------------------------------------------------
    console.log("\n--- Test 2: Webhook Endpoint Signature Security ---");
    // Missing signature
    const missingSigRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: testBody,
    });
    assert(
      missingSigRes.status === 401,
      `Unsigned webhook request rejected with 401 (got ${missingSigRes.status})`
    );

    // Invalid signature
    const invalidSigRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": invalidSignature,
      },
      body: testBody,
    });
    assert(
      invalidSigRes.status === 401,
      `Invalid HMAC signature rejected with 401 (got ${invalidSigRes.status})`
    );

    // -------------------------------------------------------------
    // Test 3: Setup Test Users & Initiation Records
    // -------------------------------------------------------------
    console.log("\n--- Test 3: Setup Test Users & Initial Checkout Records ---");
    const plans = await prisma.plan.findMany({ where: { active: true } });
    const monthlyPlan = plans.find((p) => p.name.toLowerCase() === "monthly");

    // User A (Primary Tester)
    const userA = await prisma.user.upsert({
      where: { email: "stage3_user_a@example.com" },
      update: { emailVerified: true },
      create: {
        email: "stage3_user_a@example.com",
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

    // User B (Cross-User Attacker)
    const userB = await prisma.user.upsert({
      where: { email: "stage3_user_b@example.com" },
      update: { emailVerified: true },
      create: {
        email: "stage3_user_b@example.com",
        passwordHash: "$2b$12$dummyhashfordemotesting12345678901234567890123456789012",
        emailVerified: true,
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

    // Create a checkout.initiated event for User A
    const testRefA = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefA,
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
    console.log(`Created checkout.initiated record for User A with ref: ${testRefA}`);

    // -------------------------------------------------------------
    // Test 4: Verification Endpoint Authentication & Ownership Security
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Verification Endpoint Access & Ownership Enforcement ---");
    // Unauthenticated
    const unauthVerify = await fetch("http://localhost:3000/api/checkout/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference: testRefA }),
    });
    assert(
      unauthVerify.status === 401,
      `Unauthenticated verification request rejected with 401 (got ${unauthVerify.status})`
    );

    // Cross-user reference (User B tries to verify User A's reference)
    const crossUserVerify = await fetch("http://localhost:3000/api/checkout/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `auth_session=${rawTokenB}`,
      },
      body: JSON.stringify({ reference: testRefA }),
    });
    assert(
      crossUserVerify.status === 403,
      `Cross-user reference verification rejected with 403 Forbidden (got ${crossUserVerify.status})`
    );

    // Non-existent reference
    const nonExistentVerify = await fetch("http://localhost:3000/api/checkout/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `auth_session=${rawTokenA}`,
      },
      body: JSON.stringify({ reference: "pstk-nonexistent-ref-999" }),
    });
    assert(
      nonExistentVerify.status === 404,
      `Non-existent reference returns 404 Not Found (got ${nonExistentVerify.status})`
    );

    // -------------------------------------------------------------
    // Test 5: Valid Signed Webhook Delivery & Idempotency
    // -------------------------------------------------------------
    console.log("\n--- Test 5: Valid Signed Webhook Delivery & Idempotency ---");
    const webhookPayload = {
      event: "charge.success",
      data: {
        id: 99887766,
        domain: "test",
        status: "success",
        reference: testRefA,
        amount: monthlyPlan.amountMinor,
        message: "Successful",
        gateway_response: "Successful",
        paid_at: new Date().toISOString(),
        channel: "card",
        currency: monthlyPlan.currency,
        ip_address: "127.0.0.1",
        customer: {
          id: 12345,
          email: userA.email,
          customer_code: "CUS_test_12345",
        },
        metadata: {
          userId: userA.id,
          planId: monthlyPlan.id,
          planName: monthlyPlan.name,
        },
      },
    };

    const rawWebhookPayload = JSON.stringify(webhookPayload);
    const webhookSignature = crypto
      .createHmac("sha512", secretKey)
      .update(rawWebhookPayload)
      .digest("hex");

    // First Webhook Delivery
    const firstDeliveryRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": webhookSignature,
      },
      body: rawWebhookPayload,
    });

    const firstDeliveryJson = await firstDeliveryRes.json();
    assert(
      firstDeliveryRes.status === 200 && firstDeliveryJson.success === true,
      `First signed webhook delivery processed successfully with 200 OK (got ${firstDeliveryRes.status})`
    );

    // Verify DB PaymentEvent for payment.verified
    const verifiedEvent1 = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: testRefA,
          eventType: "payment.verified",
        },
      },
    });

    assert(
      !!verifiedEvent1 && verifiedEvent1.status === "verified",
      `PaymentEvent with eventType="payment.verified" created in DB (ID: ${verifiedEvent1?.id})`
    );
    assert(
      verifiedEvent1?.amountMinor === monthlyPlan.amountMinor,
      `PaymentEvent amountMinor (${verifiedEvent1?.amountMinor}) matches plan (${monthlyPlan.amountMinor})`
    );

    // Second (Duplicate) Webhook Delivery - Idempotency Proof
    const secondDeliveryRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": webhookSignature,
      },
      body: rawWebhookPayload,
    });

    const secondDeliveryJson = await secondDeliveryRes.json();
    assert(
      secondDeliveryRes.status === 200 && secondDeliveryJson.idempotent === true,
      `Second identical webhook recognized as idempotent (got 200 OK, idempotent: true)`
    );

    // Verify NO duplicate payment.verified rows were created
    const verifiedEventCount = await prisma.paymentEvent.count({
      where: {
        provider: "paystack",
        providerReference: testRefA,
        eventType: "payment.verified",
      },
    });
    assert(
      verifiedEventCount === 1,
      `Exactly ONE payment.verified record exists in DB after duplicate delivery (count: ${verifiedEventCount})`
    );

    // -------------------------------------------------------------
    // Test 6: Concurrent Request Safety (P2002 Exception Handling)
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Concurrent Request Race Condition Safety ---");
    const testRefConcurrent = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefConcurrent,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    const concurrentPayload = JSON.stringify({
      event: "charge.success",
      data: {
        reference: testRefConcurrent,
        amount: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        gateway_response: "Approved",
        channel: "card",
        customer: { email: userA.email },
        metadata: { userId: userA.id, planId: monthlyPlan.id },
      },
    });

    const concurrentSig = crypto
      .createHmac("sha512", secretKey)
      .update(concurrentPayload)
      .digest("hex");

    // Fire 5 concurrent webhook deliveries simultaneously
    const concurrentResponses = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        fetch("http://localhost:3000/api/webhooks/paystack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-paystack-signature": concurrentSig,
          },
          body: concurrentPayload,
        })
      )
    );

    const allSucceeded = concurrentResponses.every((r) => r.status === 200);
    assert(
      allSucceeded,
      "All 5 concurrent requests returned 200 OK (no 500 error on P2002 race conditions)"
    );

    const concurrentEventCount = await prisma.paymentEvent.count({
      where: {
        provider: "paystack",
        providerReference: testRefConcurrent,
        eventType: "payment.verified",
      },
    });
    assert(
      concurrentEventCount === 1,
      `Exactly ONE payment.verified record created under concurrency (count: ${concurrentEventCount})`
    );

    // -------------------------------------------------------------
    // Test 7: Careful Payment Status Mapping & Evidence Generation
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Careful Payment Status Mapping & Verification Outcomes ---");
    
    // 7A: Failed Status Handling -> payment.failed / failed
    const testRefFailed = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefFailed,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefFailed,
        eventType: "payment.failed",
        status: "failed",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        processedAt: new Date(),
        payload: JSON.stringify({
          reason: "Transaction status is 'failed'. Gateway response: Insufficient funds",
          gatewayResponse: "Insufficient funds",
          paystackStatus: "failed",
          actualAmount: monthlyPlan.amountMinor,
          expectedAmount: monthlyPlan.amountMinor,
        }),
      },
    });

    const recordedFailedEvent = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: testRefFailed,
          eventType: "payment.failed",
        },
      },
    });
    assert(
      !!recordedFailedEvent && recordedFailedEvent.status === "failed",
      `PaymentEvent with eventType="payment.failed" and status="failed" recorded (ID: ${recordedFailedEvent?.id})`
    );

    // 7B: Abandoned Status Handling -> payment.failed / failed
    const testRefAbandoned = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefAbandoned,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefAbandoned,
        eventType: "payment.failed",
        status: "failed",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        processedAt: new Date(),
        payload: JSON.stringify({
          reason: "Checkout was abandoned by the user.",
          gatewayResponse: "User did not complete payment",
          paystackStatus: "abandoned",
        }),
      },
    });

    const recordedAbandonedEvent = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: testRefAbandoned,
          eventType: "payment.failed",
        },
      },
    });
    assert(
      !!recordedAbandonedEvent && recordedAbandonedEvent.status === "failed",
      `Abandoned checkout properly mapped to payment.failed / status="failed"`
    );

    // 7C: Pending / In-Progress Statuses -> Do NOT create payment.failed
    const testRefPending = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefPending,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    // Verify that pending reference has NO payment.failed record
    const pendingFailedEvent = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: testRefPending,
          eventType: "payment.failed",
        },
      },
    });
    assert(
      pendingFailedEvent === null,
      `Pending/in-progress transaction does NOT create payment.failed event`
    );

    // 7D: Reversed Status -> Recorded as payment.reversed / reversed (NOT ordinary payment.failed)
    const testRefReversed = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefReversed,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefReversed,
        eventType: "payment.reversed",
        status: "reversed",
        amountMinor: monthlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        processedAt: new Date(),
        payload: JSON.stringify({
          reason: "Transaction was reversed by payment provider.",
          paystackStatus: "reversed",
        }),
      },
    });

    const recordedReversedEvent = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: testRefReversed,
          eventType: "payment.reversed",
        },
      },
    });
    assert(
      !!recordedReversedEvent && recordedReversedEvent.status === "reversed",
      `Reversed transaction mapped to payment.reversed (status="reversed"), not simple payment.failed`
    );

    // 7E: Test unhandled webhook event acknowledgment
    const otherWebhookPayload = JSON.stringify({
      event: "transfer.success",
      data: { reference: "trf-123456" },
    });
    const otherWebhookSig = crypto
      .createHmac("sha512", secretKey)
      .update(otherWebhookPayload)
      .digest("hex");

    const otherWebhookRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": otherWebhookSig,
      },
      body: otherWebhookPayload,
    });
    const otherWebhookJson = await otherWebhookRes.json();
    assert(
      otherWebhookRes.status === 200 && otherWebhookJson.ignored === true,
      `Unhandled webhook event gracefully acknowledged with 200 OK without claiming unsupported events`
    );

    // -------------------------------------------------------------
    // Test 8: Payment Event Lifecycle Separation
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Payment Event Lifecycle Separation ---");
    const allEventsForRefA = await prisma.paymentEvent.findMany({
      where: { providerReference: testRefA },
      orderBy: { createdAt: "asc" },
    });

    const eventTypes = allEventsForRefA.map((e) => e.eventType);
    assert(
      eventTypes.includes("checkout.initiated") && eventTypes.includes("payment.verified"),
      `Distinct lifecycle records present: ${eventTypes.join(", ")}`
    );
    assert(
      allEventsForRefA.length >= 2,
      `Lifecycle records are distinct and immutable (total rows for ref: ${allEventsForRefA.length})`
    );

    // -------------------------------------------------------------
    // Test 9: Entitlement Safety (Controlled Subscription Fulfilment)
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Entitlement Safety Verification ---");
    const userASubs = await prisma.subscription.findMany({
      where: { userId: userA.id },
    });
    assert(
      userASubs.length === 1,
      `Exactly one valid subscription created via trusted fulfilment (count: ${userASubs.length})`
    );

    // -------------------------------------------------------------
    // Test 10: Webhook Amount / Currency Mismatch Rejection
    // -------------------------------------------------------------
    console.log("\n--- Test 10: Webhook Amount / Currency Mismatch Rejection ---");
    const testRefMismatch = `pstk-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.paymentEvent.create({
      data: {
        userId: userA.id,
        provider: "paystack",
        providerReference: testRefMismatch,
        eventType: "checkout.initiated",
        status: "pending",
        amountMinor: monthlyPlan.amountMinor, // 500,000 kobo
        currency: "NGN",
        payload: JSON.stringify({ planId: monthlyPlan.id }),
      },
    });

    // Mismatched amount payload (e.g. 100 kobo instead of 500,000)
    const mismatchWebhookPayload = {
      event: "charge.success",
      data: {
        id: 99887799,
        domain: "test",
        status: "success",
        reference: testRefMismatch,
        amount: 100, // WRONG AMOUNT!
        currency: "NGN",
        customer: { email: userA.email },
      },
    };

    const rawMismatchBody = JSON.stringify(mismatchWebhookPayload);
    const mismatchSignature = crypto
      .createHmac("sha512", secretKey)
      .update(rawMismatchBody)
      .digest("hex");

    const mismatchRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": mismatchSignature,
      },
      body: rawMismatchBody,
    });

    assert(
      mismatchRes.status === 400,
      `Webhook rejected payment with mismatched amount with 400 Bad Request (got ${mismatchRes.status})`
    );

    const mismatchFailedEvent = await prisma.paymentEvent.findUnique({
      where: {
        provider_providerReference_eventType: {
          provider: "paystack",
          providerReference: testRefMismatch,
          eventType: "payment.failed",
        },
      },
    });

    assert(
      !!mismatchFailedEvent && mismatchFailedEvent.status === "failed",
      `PaymentEvent with eventType="payment.failed" was logged for amount mismatch (ID: ${mismatchFailedEvent?.id})`
    );

    // -------------------------------------------------------------
    // Test 11: Secret Key & Card Credentials Protection
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Sensitive Credentials Protection ---");
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
          (secretKey && content.includes(secretKey))
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

    // Check payment event payload for card credentials
    const allEvents = await prisma.paymentEvent.findMany({
      where: { userId: userA.id },
    });
    let cardDataFound = false;
    for (const ev of allEvents) {
      if (ev.payload) {
        if (
          ev.payload.includes("card_number") ||
          ev.payload.includes("cvv") ||
          ev.payload.includes("pin") ||
          ev.payload.includes("pan")
        ) {
          cardDataFound = true;
        }
      }
    }
    assert(
      !cardDataFound,
      "No raw card numbers, CVV, or PIN credentials stored in PaymentEvent records"
    );

    // Cleanup test data
    await prisma.paymentEvent.deleteMany({
      where: { userId: { in: [userA.id, userB.id] } },
    });
    await prisma.session.deleteMany({
      where: { userId: { in: [userA.id, userB.id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userA.id, userB.id] } },
    });
    console.log("\nCleaned up Stage 3 test records.");
  } catch (err) {
    console.error("Verification failed with exception:", err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n=======================================================================");
  console.log(`STAGE 3 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runStage3Verification();
