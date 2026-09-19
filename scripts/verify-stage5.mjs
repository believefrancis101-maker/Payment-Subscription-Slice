import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  calculateUpgradeProration,
  getCalendarPeriodDays,
  getDaysRemaining,
} from "../src/lib/proration.ts";

const prisma = new PrismaClient();

const MS_PER_DAY = 86_400_000;

function daysAgo(ms) {
  return new Date(Date.now() - ms);
}

function daysFromNow(ms) {
  return new Date(Date.now() + ms);
}

async function createAuthedUser(email) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: "$2b$12$dummyhashfordemotesting12345678901234567890123456789012",
      emailVerified: true,
    },
  });

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  await prisma.session.create({
    data: {
      userId: user.id,
      sessionToken: tokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  });

  return { user, rawToken };
}

function authCookie(rawToken) {
  return `auth_session=${rawToken}`;
}

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passed++;
  } else {
    console.error(`[FAIL] ${message}`);
    failed++;
  }
}

let passed = 0;
let failed = 0;

function signPayload(secretKey, body) {
  return crypto.createHmac("sha512", secretKey).update(body).digest("hex");
}

function makeWebhookBody({ reference, amount, currency, email, metadata }) {
  return JSON.stringify({
    event: "charge.success",
    data: {
      id: Math.floor(Math.random() * 1e9),
      domain: "test",
      status: "success",
      reference,
      amount,
      message: "Successful",
      gateway_response: "Approved",
      paid_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      channel: "card",
      currency,
      customer: {
        id: Math.floor(Math.random() * 1e6),
        email,
        customer_code: "CUS_stage5_test",
      },
      metadata,
    },
  });
}

async function runStage5Verification() {
  console.log("=======================================================================");
  console.log("STAGE 5 VERIFICATION: Monthly -> Yearly Upgrade with Server-Side Proration");
  console.log("=======================================================================\n");

  const envContent = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
  const keyMatch = envContent.match(/^PAYSTACK_SECRET_KEY=(.*)$/m);
  const secretKey = keyMatch ? keyMatch[1].trim().replace(/^["']|["']$/g, "").trim() : "";

  const paystackSource = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "paystack.ts"),
    "utf-8"
  );

  try {
    const plans = await prisma.plan.findMany({ where: { active: true } });
    const monthlyPlan = plans.find((p) => p.name.toLowerCase() === "monthly");
    const yearlyPlan = plans.find((p) => p.name.toLowerCase() === "yearly");

    assert(!!monthlyPlan, "Monthly plan exists in database");
    assert(!!yearlyPlan, "Yearly plan exists in database");

    if (!monthlyPlan || !yearlyPlan) {
      throw new Error("Required plans missing");
    }

    // -------------------------------------------------------------
    // Test 0: Pure proration / calendar math (server helper imported)
    // -------------------------------------------------------------
    console.log("\n--- Test 0: Proration & Calendar Boundary Math ---");

    assert(
      getCalendarPeriodDays(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-31T00:00:00Z")) === 30,
      "Normal 30-day monthly period: Jan 1 -> Jan 31 = 30 days"
    );
    assert(
      getCalendarPeriodDays(new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z")) === 31,
      "31-day monthly period: Jan 1 -> Feb 1 = 31 days"
    );
    assert(
      getCalendarPeriodDays(new Date("2026-02-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z")) === 28,
      "February (non-leap 2026) monthly period: Feb 1 -> Mar 1 = 28 days"
    );
    assert(
      getCalendarPeriodDays(new Date("2024-02-01T00:00:00Z"), new Date("2024-03-01T00:00:00Z")) === 29,
      "Leap-year February (2024) monthly period: Feb 1 -> Mar 1 = 29 days"
    );

    const start = new Date("2026-01-01T00:00:00Z");
    const end30 = new Date("2026-01-31T00:00:00Z");
    assert(
      getDaysRemaining(start, end30, start, 30) === 30,
      "Upgrade exactly on period start: 30 of 30 days remaining"
    );
    assert(
      getDaysRemaining(start, end30, new Date("2026-01-13T00:00:00Z"), 30) === 18,
      "Upgrade on day 12 of a 30-day period: 18 days remaining (documented example)"
    );
    assert(
      getDaysRemaining(start, end30, new Date("2026-01-30T00:00:00Z"), 30) === 1,
      "Upgrade one day before period end: exactly 1 day remaining"
    );
    assert(
      getDaysRemaining(start, end30, end30, 30) === 0,
      "Period-end boundary: 0 days remaining at the exact period end"
    );

    const exampleProration = calculateUpgradeProration({
      oldPeriodAmountMinor: 500000,
      newPeriodAmountMinor: 5000000,
      currency: "NGN",
      currentPeriodStart: start,
      currentPeriodEnd: end30,
      now: new Date("2026-01-13T00:00:00Z"),
    });
    assert(
      exampleProration.currentPeriodDays === 30 && exampleProration.daysRemaining === 18,
      `Proration uses 30-day period with 18 days remaining (got ${exampleProration.currentPeriodDays}/${exampleProration.daysRemaining})`
    );
    assert(
      exampleProration.creditMinor === 300000,
      `Exact example credit: 500000 x 18 / 30 = 300000 kobo (got ${exampleProration.creditMinor})`
    );
    assert(
      exampleProration.chargeMinor === 4700000,
      `Exact example charge: 5000000 - 300000 = 4700000 kobo (got ${exampleProration.chargeMinor})`
    );
    assert(
      Number.isInteger(exampleProration.creditMinor) && Number.isInteger(exampleProration.chargeMinor),
      "Proration values are integer minor units"
    );

    const createdUsers = [];
    const createdSubs = [];

    try {
      // -------------------------------------------------------------
      // Test 1: No active subscription cannot upgrade
      // -------------------------------------------------------------
      console.log("\n--- Test 1: Rejection - No Active Subscription ---");
      const { user: noSubUser, rawToken: noSubToken } = await createAuthedUser(
        "stage5_nosub@example.com"
      );
      createdUsers.push(noSubUser.id);

      const noSubRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(noSubToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      assert(
        noSubRes.status === 409,
        `User without an active subscription is rejected with 409 (got ${noSubRes.status})`
      );

      // -------------------------------------------------------------
      // Test 2: Free plan cannot upgrade to Yearly
      // -------------------------------------------------------------
      console.log("\n--- Test 2: Rejection - Free Plan User ---");
      const { user: freeUser, rawToken: freeToken } = await createAuthedUser(
        "stage5_free@example.com"
      );
      createdUsers.push(freeUser.id);
      const freePlan = plans.find((p) => p.name.toLowerCase() === "free");
      const freeSub = await prisma.subscription.create({
        data: {
          userId: freeUser.id,
          planId: freePlan.id,
          status: "active",
          currency: freePlan.currency,
          amountMinor: 0,
          currentPeriodStart: daysAgo(1 * MS_PER_DAY),
          currentPeriodEnd: daysFromNow(30 * MS_PER_DAY),
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-free-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(freeSub.id);

      const freeRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(freeToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      assert(
        freeRes.status === 409,
        `Free-plan user cannot start a paid upgrade (got ${freeRes.status})`
      );

      // -------------------------------------------------------------
      // Test 3: Yearly user cannot upgrade Monthly -> Yearly
      // -------------------------------------------------------------
      console.log("\n--- Test 3: Rejection - Yearly User ---");
      const { user: yearlyUser, rawToken: yearlyToken } = await createAuthedUser(
        "stage5_yearly@example.com"
      );
      createdUsers.push(yearlyUser.id);
      const yearlySub = await prisma.subscription.create({
        data: {
          userId: yearlyUser.id,
          planId: yearlyPlan.id,
          status: "active",
          currency: yearlyPlan.currency,
          amountMinor: yearlyPlan.amountMinor,
          currentPeriodStart: daysAgo(5 * MS_PER_DAY),
          currentPeriodEnd: daysFromNow(360 * MS_PER_DAY),
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-yearly-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(yearlySub.id);

      const yearlyRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(yearlyToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      assert(
        yearlyRes.status === 409,
        `Yearly subscriber cannot start a Monthly -> Yearly upgrade (got ${yearlyRes.status})`
      );

      // -------------------------------------------------------------
      // Test 4: cancelAtPeriodEnd user is rejected without silent override
      // -------------------------------------------------------------
      console.log("\n--- Test 4: Rejection - cancelAtPeriodEnd ---");
      const { user: cancelUser, rawToken: cancelToken } = await createAuthedUser(
        "stage5_cancel@example.com"
      );
      createdUsers.push(cancelUser.id);
      const cancelSub = await prisma.subscription.create({
        data: {
          userId: cancelUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: daysAgo(10 * MS_PER_DAY),
          currentPeriodEnd: daysFromNow(20 * MS_PER_DAY),
          cancelAtPeriodEnd: true,
          originatingPaymentReference: `pstk-stage5-cancel-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(cancelSub.id);

      const cancelRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(cancelToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      assert(
        cancelRes.status === 409,
        `Subscription scheduled to cancel (cancelAtPeriodEnd) is rejected with 409 (got ${cancelRes.status})`
      );
      const cancelSubAfter = await prisma.subscription.findUnique({
        where: { id: cancelSub.id },
      });
      assert(
        cancelSubAfter?.cancelAtPeriodEnd === true,
        "Cancellation state was NOT silently overridden by the upgrade flow"
      );

      // -------------------------------------------------------------
      // Test 5: Expired (period ended) monthly subscription cannot upgrade
      // -------------------------------------------------------------
      console.log("\n--- Test 5: Rejection - Expired Period ---");
      const { user: expiredUser, rawToken: expiredToken } = await createAuthedUser(
        "stage5_expired@example.com"
      );
      createdUsers.push(expiredUser.id);
      const expiredSub = await prisma.subscription.create({
        data: {
          userId: expiredUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: daysAgo(32 * MS_PER_DAY),
          currentPeriodEnd: daysAgo(2 * MS_PER_DAY),
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-expired-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(expiredSub.id);

      const expiredRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(expiredToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      assert(
        expiredRes.status === 409,
        `Period-end boundary: subscription outside currentPeriodEnd is rejected (got ${expiredRes.status})`
      );

      // -------------------------------------------------------------
      // Test 6: Exact 30-day documented example via live quote endpoint
      // -------------------------------------------------------------
      console.log("\n--- Test 6: Exact 30-Day Example (live quote) ---");
      const { user: exampleUser, rawToken: exampleToken } = await createAuthedUser(
        "stage5_example@example.com"
      );
      createdUsers.push(exampleUser.id);
      const exampleEnd = daysFromNow(18 * MS_PER_DAY);
      const exampleStart = new Date(exampleEnd.getTime() - 30 * MS_PER_DAY);
      const exampleSub = await prisma.subscription.create({
        data: {
          userId: exampleUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: exampleStart,
          currentPeriodEnd: exampleEnd,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-example-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(exampleSub.id);

      const exampleQuoteRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(exampleToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      const exampleQuote = await exampleQuoteRes.json();
      assert(
        exampleQuoteRes.status === 200 && exampleQuote.success === true,
        "Monthly subscriber receives upgrade quote (200 OK)"
      );
      assert(
        exampleQuote.proration?.currentPeriodDays === 30,
        `Current period is 30 days (got ${exampleQuote.proration?.currentPeriodDays})`
      );
      assert(
        exampleQuote.proration?.daysRemaining === 18,
        `Exactly 18 days remaining (got ${exampleQuote.proration?.daysRemaining})`
      );
      assert(
        exampleQuote.proration?.creditMinor === 300000,
        `Exactly 300000 kobo unused credit = NGN 3,000 (got ${exampleQuote.proration?.creditMinor})`
      );
      assert(
        exampleQuote.proration?.chargeMinor === 4700000,
        `Exactly 4700000 kobo charge = NGN 47,000 (got ${exampleQuote.proration?.chargeMinor})`
      );
      assert(
        exampleQuote.proration?.oldPeriodAmountMinor === monthlyPlan.amountMinor &&
          exampleQuote.proration?.newPeriodAmountMinor === yearlyPlan.amountMinor,
        "old/new amounts are the DB Monthly (500000) and Yearly (5000000) minor-unit amounts"
      );
      assert(
        exampleQuote.proration?.currency === "NGN",
        "Quote currency is NGN"
      );
      assert(
        exampleQuote.targetPlan?.id === yearlyPlan.id,
        "Yearly target plan is loaded from the database"
      );

      // -------------------------------------------------------------
      // Test 7: Quote does not create changes/payments; auto target works
      // -------------------------------------------------------------
      console.log("\n--- Test 7: Quote Is Read-Only & Auto-Targets Yearly ---");
      const changeCountAfterQuote = await prisma.subscriptionChange.count({
        where: { subscriptionId: exampleSub.id },
      });
      const eventCountAfterQuote = await prisma.paymentEvent.count({
        where: { subscriptionId: exampleSub.id },
      });
      assert(
        changeCountAfterQuote === 0 && eventCountAfterQuote === 0,
        "Loading a quote persists nothing (no SubscriptionChange, no PaymentEvent)"
      );

      const autoTargetRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(exampleToken) },
        body: JSON.stringify({}),
      });
      const autoTargetQuote = await autoTargetRes.json();
      assert(
        autoTargetRes.status === 200 && autoTargetQuote.targetPlan?.id === yearlyPlan.id,
        "Quote without a target id defaults to the active seeded Yearly plan"
      );

      const invalidTargetRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(exampleToken) },
        body: JSON.stringify({ toPlanId: monthlyPlan.id }),
      });
      assert(
        invalidTargetRes.status === 409,
        `Non-Yearly target plan is rejected (got ${invalidTargetRes.status})`
      );

      // -------------------------------------------------------------
      // Test 8-11: Initiate with exact server charge + no plan_code
      // -------------------------------------------------------------
      console.log("\n--- Test 8-11: Upgrade Checkout Initiation (server-derived charge) ---");
      const { user: flowUser, rawToken: flowToken } = await createAuthedUser(
        "stage5_flow@example.com"
      );
      createdUsers.push(flowUser.id);
      const flowStart = daysAgo(10 * MS_PER_DAY);
      const flowEnd = daysFromNow(20 * MS_PER_DAY);
      const flowSub = await prisma.subscription.create({
        data: {
          userId: flowUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: flowStart,
          currentPeriodEnd: flowEnd,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-flow-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(flowSub.id);

      const expectedProration = calculateUpgradeProration({
        oldPeriodAmountMinor: monthlyPlan.amountMinor,
        newPeriodAmountMinor: yearlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        currentPeriodStart: flowStart,
        currentPeriodEnd: flowEnd,
        now: new Date(),
      });

      // Forged amounts must be ignored entirely.
      const initiateRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(flowToken) },
        body: JSON.stringify({
          toPlanId: yearlyPlan.id,
          amountMinor: 1,
          creditMinor: 1,
          daysRemaining: 1,
        }),
      });
      const initiateJson = await initiateRes.json();
      assert(
        initiateRes.status === 200 && initiateJson.success === true,
        "Upgrade checkout initiation succeeds (200) with a real Paystack authorization URL"
      );
      assert(
        !!initiateJson.authorizationUrl && !!initiateJson.reference,
        "Paystack hosted checkout authorization URL and unique reference returned"
      );
      assert(
        initiateJson.chargeMinor === expectedProration.chargeMinor,
        `Server-derived charge used, client-forged amount ignored (charge = ${initiateJson.chargeMinor})`
      );
      assert(
        initiateJson.chargeMinor !== 1,
        "Client-supplied amountMinor (1) was NOT accepted"
      );
      assert(
        initiateJson.chargeMinor === yearlyPlan.amountMinor - initiateJson.creditMinor &&
          Number.isInteger(initiateJson.creditMinor) &&
          Number.isInteger(initiateJson.chargeMinor) &&
          initiateJson.creditMinor === expectedProration.creditMinor,
        "chargeMinor = Yearly (5000000) - creditMinor; both integer minor units"
      );

      const flowRef = initiateJson.reference;
      const flowChangeId = initiateJson.changeId;

      const persistedChange = await prisma.subscriptionChange.findUnique({
        where: { id: flowChangeId },
      });
      assert(
        persistedChange?.status === "pending",
        "SubscriptionChange persisted with status = pending"
      );
      assert(
        persistedChange?.changeType === "upgrade",
        "SubscriptionChange changeType = upgrade"
      );
      assert(
        persistedChange?.fromPlanId === monthlyPlan.id &&
          persistedChange?.toPlanId === yearlyPlan.id,
        "SubscriptionChange records fromPlanId (Monthly) and toPlanId (Yearly)"
      );
      assert(
        persistedChange?.chargeMinor === expectedProration.chargeMinor &&
          persistedChange?.creditMinor === expectedProration.creditMinor,
        "SubscriptionChange stores the exact prorated credit and charge (minor units)"
      );
      assert(
        persistedChange?.daysRemaining === expectedProration.daysRemaining,
        "SubscriptionChange stores daysRemaining from the server calculation"
      );
      assert(
        persistedChange?.oldPeriodAmountMinor === monthlyPlan.amountMinor &&
          persistedChange?.newPeriodAmountMinor === yearlyPlan.amountMinor,
        "SubscriptionChange stores old/new period amounts in minor units"
      );
      assert(
        persistedChange?.currency === "NGN",
        "SubscriptionChange records currency NGN"
      );
      assert(
        persistedChange?.effectiveAt instanceof Date,
        "SubscriptionChange has an effectiveAt timestamp"
      );

      const initiatedEvent = await prisma.paymentEvent.findFirst({
        where: { providerReference: flowRef, eventType: "checkout.initiated" },
      });
      assert(
        !!initiatedEvent,
        "Separate checkout.initiated PaymentEvent recorded"
      );
      assert(
        initiatedEvent?.amountMinor === expectedProration.chargeMinor &&
          initiatedEvent?.currency === "NGN",
        "checkout.initiated amountMinor equals the exact server charge (Paystack init amount)"
      );
      assert(
        initiatedEvent?.status === "pending",
        "checkout.initiated started with status = pending"
      );
      const initiatedPayload = initiatedEvent ? JSON.parse(initiatedEvent.payload) : {};
      assert(
        initiatedPayload.changeType === "upgrade" &&
          initiatedPayload.changeId === flowChangeId &&
          initiatedPayload.subscriptionId === flowSub.id,
        "checkout.initiated payload carries upgrade identity & change id for later reconstruction"
      );
      assert(
        !("plan_code" in initiatedPayload) &&
          !("plan" in initiatedPayload) &&
          initiatedPayload.chargeMinor === expectedProration.chargeMinor,
        "No Paystack plan/plan_code recorded for the upgrade transaction"
      );
      assert(
        !paystackSource.includes("plan_code") && !paystackSource.includes("planCode"),
        "Paystack initializer library never sends a plan or plan_code"
      );
      assert(
        yearlyPlan.providerPlanCode === null,
        "Yearly plan has no provider plan code (one-time transaction only)"
      );

      const flowSubAfterInit = await prisma.subscription.findUnique({
        where: { id: flowSub.id },
      });
      assert(
        flowSubAfterInit?.planId === monthlyPlan.id &&
          flowSubAfterInit?.amountMinor === monthlyPlan.amountMinor,
        "Subscription is NOT modified by initiation (still Monthly)"
      );

      // -------------------------------------------------------------
      // Test 12-15: Verified webhook applies the upgrade exactly once
      // -------------------------------------------------------------
      console.log("\n--- Test 12-15: Verified Upgrade Fulfilment via Webhook ---");
      const webhookBody = makeWebhookBody({
        reference: flowRef,
        amount: expectedProration.chargeMinor,
        currency: "NGN",
        email: flowUser.email,
        metadata: {
          userId: flowUser.id,
          changeId: flowChangeId,
          toPlanId: yearlyPlan.id,
        },
      });

      const whRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-paystack-signature": signPayload(secretKey, webhookBody),
        },
        body: webhookBody,
      });
      const whJson = await whRes.json();
      assert(
        whRes.status === 200 && whJson.success === true,
        "Signed charge.success webhook accepted (200 OK)"
      );

      const flowSubAfter = await prisma.subscription.findUnique({
        where: { id: flowSub.id },
        include: { plan: true },
      });
      assert(
        flowSubAfter?.planId === yearlyPlan.id,
        "Existing subscription changed from Monthly to Yearly plan"
      );
      assert(
        flowSubAfter?.amountMinor === yearlyPlan.amountMinor &&
          flowSubAfter?.currency === yearlyPlan.currency,
        "Subscription amount/currency updated to Yearly minor units"
      );
      assert(
        flowSubAfter?.status === "active",
        "Subscription remains status = active"
      );
      assert(
        (await prisma.subscription.count({ where: { userId: flowUser.id, status: "active" } })) === 1,
        "No second Subscription row was created for the upgrade"
      );

      const subStart = new Date(flowSubAfter.currentPeriodStart);
      const subEnd = new Date(flowSubAfter.currentPeriodEnd);
      assert(
        subStart.getUTCFullYear() === subEnd.getUTCFullYear() - 1 &&
          subStart.getUTCMonth() === subEnd.getUTCMonth() &&
          subStart.getUTCDate() === subEnd.getUTCDate(),
        `New period is exactly one calendar year: ${subStart.toISOString()} -> ${subEnd.toISOString()}`
      );
      assert(
        Math.abs(new Date(flowSubAfter.currentPeriodStart).getTime() - Date.now()) < MS_PER_DAY,
        "New Yearly period begins at the upgrade effective time"
      );
      assert(
        flowSubAfter?.pendingUpgradeReference === null,
        "Pending-upgrade claim (pendingUpgradeReference) is released on fulfilment"
      );

      const verifiedEvents = await prisma.paymentEvent.findMany({
        where: { providerReference: flowRef, eventType: "payment.verified" },
      });
      const fulfilledEvents = await prisma.paymentEvent.findMany({
        where: { providerReference: flowRef, eventType: "payment.fulfilled" },
      });
      assert(
        verifiedEvents.length === 1 && verifiedEvents[0]?.status === "verified",
        "Exactly one payment.verified event recorded with status = verified"
      );
      assert(
        verifiedEvents[0]?.amountMinor === expectedProration.chargeMinor &&
          verifiedEvents[0]?.currency === "NGN",
        "payment.verified records the prorated charge in minor units"
      );
      assert(
        verifiedEvents[0]?.subscriptionId === null,
        "payment.verified row is immutable (no subscriptionId attached later)"
      );
      assert(
        fulfilledEvents.length === 1 &&
          fulfilledEvents[0]?.subscriptionId === flowSub.id &&
          fulfilledEvents[0]?.amountMinor === expectedProration.chargeMinor,
        "Exactly one payment.fulfilled recorded with the resulting subscriptionId and charge"
      );

      const appliedChanges = await prisma.subscriptionChange.count({
        where: { subscriptionId: flowSub.id, status: "applied" },
      });
      assert(
        appliedChanges === 1,
        "Exactly one SubscriptionChange transitioned to status = applied"
      );

      // -------------------------------------------------------------
      // Test 16: Duplicate webhook is idempotent
      // -------------------------------------------------------------
      console.log("\n--- Test 16: Duplicate Webhook Idempotency ---");
      const dupWhRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-paystack-signature": signPayload(secretKey, webhookBody),
        },
        body: webhookBody,
      });
      const dupWhJson = await dupWhRes.json();
      assert(
        dupWhRes.status === 200 && (dupWhJson.idempotent === true || dupWhJson.success === true),
        `Duplicate webhook handled gracefully (200 OK)`
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: flowRef, eventType: "payment.fulfilled" } })) === 1,
        "Duplicate webhook did not create a second payment.fulfilled"
      );
      assert(
        (await prisma.subscriptionChange.count({ where: { subscriptionId: flowSub.id, status: "applied" } })) === 1,
        "Duplicate webhook did not apply the change twice"
      );

      // -------------------------------------------------------------
      // Test 17: Browser verification converges after webhook (webhook-first)
      // -------------------------------------------------------------
      console.log("\n--- Test 17: Browser Verification After Webhook (idempotent convergence) ---");
      const verifyRes = await fetch("http://localhost:3000/api/checkout/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(flowToken) },
        body: JSON.stringify({ reference: flowRef }),
      });
      const verifyJson = await verifyRes.json();
      assert(
        verifyRes.status === 200 && verifyJson.verified === true && verifyJson.idempotent === true,
        `Browser verification arriving after webhook returns verified + idempotent (got ${verifyRes.status})`
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: flowRef, eventType: "payment.verified" } })) === 1,
        "Browser verification did not create a duplicate payment.verified"
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: flowRef, eventType: "payment.fulfilled" } })) === 1,
        "Browser verification did not create a duplicate payment.fulfilled"
      );

      // -------------------------------------------------------------
      // Test 18: Webhook after browser verification already recorded verified
      // -------------------------------------------------------------
      console.log("\n--- Test 18: Webhook Arriving After Browser-Verified Evidence ---");
      const { user: flowUser2, rawToken: flowToken2 } = await createAuthedUser(
        "stage5_flow2@example.com"
      );
      createdUsers.push(flowUser2.id);
      const flow2Start = daysAgo(10 * MS_PER_DAY);
      const flow2End = daysFromNow(20 * MS_PER_DAY);
      const flow2Sub = await prisma.subscription.create({
        data: {
          userId: flowUser2.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: flow2Start,
          currentPeriodEnd: flow2End,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-flow2-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(flow2Sub.id);

      const flow2Proration = calculateUpgradeProration({
        oldPeriodAmountMinor: monthlyPlan.amountMinor,
        newPeriodAmountMinor: yearlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        currentPeriodStart: flow2Start,
        currentPeriodEnd: flow2End,
        now: new Date(),
      });

      const flow2Init = await fetch("http://localhost:3000/api/subscriptions/upgrade/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(flowToken2) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      const flow2InitJson = await flow2Init.json();
      const flow2Ref = flow2InitJson.reference;
      const flow2ChangeId = flow2InitJson.changeId;
      assert(
        flow2Init.status === 200 && !!flow2Ref,
        `Second user upgrade checkout initiated (reference ${flow2Ref})`
      );

      // Simulate the browser verification hop: Paystack returned success and
      // the verify route recorded payment.verified BEFORE any webhook landed.
      await prisma.paymentEvent.create({
        data: {
          userId: flowUser2.id,
          provider: "paystack",
          providerReference: flow2Ref,
          eventType: "payment.verified",
          status: "verified",
          amountMinor: flow2Proration.chargeMinor,
          currency: "NGN",
          processedAt: new Date(),
          payload: JSON.stringify({
            planId: yearlyPlan.id,
            planName: yearlyPlan.name,
            interval: yearlyPlan.interval,
            channel: "card",
            gatewayResponse: "Approved",
            domain: "test",
          }),
        },
      });

      const flow2WebhookBody = makeWebhookBody({
        reference: flow2Ref,
        amount: flow2Proration.chargeMinor,
        currency: "NGN",
        email: flowUser2.email,
        metadata: { userId: flowUser2.id, changeId: flow2ChangeId, toPlanId: yearlyPlan.id },
      });
      const flow2WhRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-paystack-signature": signPayload(secretKey, flow2WebhookBody),
        },
        body: flow2WebhookBody,
      });
      const flow2WhJson = await flow2WhRes.json();
      assert(
        flow2WhRes.status === 200 && (flow2WhJson.idempotent === true || flow2WhJson.success === true),
        `Webhook arriving after browser-verified evidence converges (200 OK)`
      );

      const flow2SubAfter = await prisma.subscription.findUnique({
        where: { id: flow2Sub.id },
        include: { plan: true },
      });
      assert(
        flow2SubAfter?.planId === yearlyPlan.id,
        "Upgrade applied exactly once when webhook follows browser verification"
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: flow2Ref, eventType: "payment.verified" } })) === 1 &&
          (await prisma.paymentEvent.count({ where: { providerReference: flow2Ref, eventType: "payment.fulfilled" } })) === 1,
        "Exactly one payment.verified and one payment.fulfilled regardless of arrival order"
      );
      assert(
        (await prisma.subscriptionChange.count({ where: { id: flow2ChangeId, status: "applied" } })) === 1,
        "Exactly one applied SubscriptionChange regardless of arrival order"
      );

      // -------------------------------------------------------------
      // Test 18b: Concurrent webhook deliveries apply the upgrade once
      // -------------------------------------------------------------
      console.log("\n--- Test 18b: Concurrent Webhook Deliveries (5x parallel) ---");
      const { user: concUser, rawToken: concToken } = await createAuthedUser(
        "stage5_conc@example.com"
      );
      createdUsers.push(concUser.id);
      const concStart = daysAgo(10 * MS_PER_DAY);
      const concEnd = daysFromNow(20 * MS_PER_DAY);
      const concSub = await prisma.subscription.create({
        data: {
          userId: concUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: concStart,
          currentPeriodEnd: concEnd,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-conc-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(concSub.id);

      const concProration = calculateUpgradeProration({
        oldPeriodAmountMinor: monthlyPlan.amountMinor,
        newPeriodAmountMinor: yearlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        currentPeriodStart: concStart,
        currentPeriodEnd: concEnd,
        now: new Date(),
      });

      const concInit = await fetch("http://localhost:3000/api/subscriptions/upgrade/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(concToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      const concInitJson = await concInit.json();
      const concRef = concInitJson.reference;
      const concChangeId = concInitJson.changeId;
      assert(concInit.status === 200 && !!concRef, "Concurrent-test upgrade checkout initiated");

      const concBody = makeWebhookBody({
        reference: concRef,
        amount: concProration.chargeMinor,
        currency: "NGN",
        email: concUser.email,
        metadata: { userId: concUser.id, changeId: concChangeId, toPlanId: yearlyPlan.id },
      });
      const concSig = signPayload(secretKey, concBody);

      const concResponses = await Promise.all(
        Array.from({ length: 5 }).map(() =>
          fetch("http://localhost:3000/api/webhooks/paystack", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-paystack-signature": concSig,
            },
            body: concBody,
          })
        )
      );
      const all2xx = concResponses.every((r) => r.status === 200 || r.status === 202);
      assert(all2xx, "All 5 concurrent webhook deliveries returned cleanly (no 500)");

      const concSubAfter = await prisma.subscription.findUnique({
        where: { id: concSub.id },
        include: { plan: true },
      });
      assert(
        concSubAfter?.planId === yearlyPlan.id,
        "Concurrent deliveries produce exactly one Monthly -> Yearly plan transition"
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: concRef, eventType: "payment.verified" } })) === 1,
        "Concurrent deliveries produce exactly one payment.verified"
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: concRef, eventType: "payment.fulfilled" } })) === 1,
        "Concurrent deliveries produce exactly one payment.fulfilled"
      );
      assert(
        (await prisma.subscriptionChange.count({ where: { id: concChangeId, status: "applied" } })) === 1,
        "Concurrent deliveries produce exactly one applied SubscriptionChange"
      );
      assert(
        (await prisma.subscription.count({ where: { userId: concUser.id } })) === 1,
        "Concurrent deliveries never create a second Subscription row"
      );

      // -------------------------------------------------------------
      // Test 19-20: Incorrect amount / currency rejected
      // -------------------------------------------------------------
      console.log("\n--- Test 19-20: Incorrect Amount & Currency Rejected ---");
      const { user: badUser, rawToken: badToken } = await createAuthedUser(
        "stage5_bad@example.com"
      );
      createdUsers.push(badUser.id);
      const badStart = daysAgo(10 * MS_PER_DAY);
      const badEnd = daysFromNow(20 * MS_PER_DAY);
      const badSub = await prisma.subscription.create({
        data: {
          userId: badUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: badStart,
          currentPeriodEnd: badEnd,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-bad-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(badSub.id);

      const badProration = calculateUpgradeProration({
        oldPeriodAmountMinor: monthlyPlan.amountMinor,
        newPeriodAmountMinor: yearlyPlan.amountMinor,
        currency: monthlyPlan.currency,
        currentPeriodStart: badStart,
        currentPeriodEnd: badEnd,
        now: new Date(),
      });

      const badInit = await fetch("http://localhost:3000/api/subscriptions/upgrade/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(badToken) },
        body: JSON.stringify({ toPlanId: yearlyPlan.id }),
      });
      const badInitJson = await badInit.json();
      const badRef = badInitJson.reference;
      const badChangeId = badInitJson.changeId;
      assert(badInit.status === 200 && !!badRef, "Bad-amount user upgrade checkout initiated");

      const wrongAmountBody = makeWebhookBody({
        reference: badRef,
        amount: yearlyPlan.amountMinor, // full Yearly price, not the prorated charge
        currency: "NGN",
        email: badUser.email,
        metadata: { userId: badUser.id, changeId: badChangeId, toPlanId: yearlyPlan.id },
      });
      const wrongAmountRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-paystack-signature": signPayload(secretKey, wrongAmountBody),
        },
        body: wrongAmountBody,
      });
      assert(
        wrongAmountRes.status === 400,
        `Incorrect amount rejected with 400 (got ${wrongAmountRes.status})`
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: badRef, eventType: "payment.failed" } })) === 1,
        "Incorrect amount records a payment.failed event"
      );
      assert(
        (await prisma.subscription.findUnique({ where: { id: badSub.id } }))?.planId === monthlyPlan.id,
        "Incorrect amount does NOT change the subscription to Yearly"
      );

      const wrongCurrencyBody = makeWebhookBody({
        reference: badRef,
        amount: badProration.chargeMinor,
        currency: "USD",
        email: badUser.email,
        metadata: { userId: badUser.id, changeId: badChangeId, toPlanId: yearlyPlan.id },
      });
      const wrongCurrencyRes = await fetch("http://localhost:3000/api/webhooks/paystack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-paystack-signature": signPayload(secretKey, wrongCurrencyBody),
        },
        body: wrongCurrencyBody,
      });
      assert(
        wrongCurrencyRes.status === 400,
        `Incorrect currency rejected with 400 (got ${wrongCurrencyRes.status})`
      );
      assert(
        (await prisma.paymentEvent.count({ where: { providerReference: badRef, eventType: "payment.verified" } })) === 0 &&
          (await prisma.paymentEvent.count({ where: { providerReference: badRef, eventType: "payment.fulfilled" } })) === 0,
        "No payment.verified or payment.fulfilled recorded for rejected currency"
      );
      assert(
        (await prisma.subscription.findUnique({ where: { id: badSub.id } }))?.planId === monthlyPlan.id,
        "Incorrect currency does NOT change the subscription to Yearly"
      );

      // -------------------------------------------------------------
      // Test 21-22: Unverified payment / browser-only callback cannot upgrade
      // -------------------------------------------------------------
      console.log("\n--- Test 21-22: Unverified Payment Cannot Upgrade ---");
      const unverifiedChanges = await prisma.subscriptionChange.count({
        where: { subscriptionId: badSub.id, status: "applied" },
      });
      const unverifiedEvent = await prisma.paymentEvent.findFirst({
        where: { providerReference: badRef, eventType: "checkout.initiated" },
      });
      assert(
        unverifiedChanges === 0 &&
          unverifiedEvent?.status === "pending" &&
          (await prisma.subscription.findUnique({ where: { id: badSub.id } }))?.planId === monthlyPlan.id,
        "An initiated but unverified payment can never apply the plan change"
      );

      // Simulate the browser-only callback: redirect to /plans?checkout_status=completed.
      // This is a plain page load and must not perform any state mutation.
      const callbackPage = await fetch(
        "http://localhost:3000/plans?checkout_status=completed&reference=whatever",
        { redirect: "manual" }
      );
      assert(
        callbackPage.status === 307 || callbackPage.status === 200,
        `Plans callback URL is reachable (got ${callbackPage.status})`
      );
      assert(
        (await prisma.subscription.findUnique({ where: { id: badSub.id } }))?.planId === monthlyPlan.id,
        "Browser-only callback does not upgrade any subscription"
      );

      // -------------------------------------------------------------
      // Test 23: No user-level entitlement flags introduced
      // -------------------------------------------------------------
      console.log("\n--- Test 23: No User-Level Entitlement Flag ---");
      const upgradedUser = await prisma.user.findUnique({ where: { id: flowUser.id } });
      assert(
        upgradedUser &&
          upgradedUser.isPaid === undefined &&
          upgradedUser.isPremium === undefined &&
          upgradedUser.paidPlan === undefined,
        "User model still contains no shortcut entitlement flags"
      );

      // -------------------------------------------------------------
      // Test 24: Server-controlled target plan (always active Yearly)
      // -------------------------------------------------------------
      console.log("\n--- Test 24: Server-Controlled Target Plan ---");
      const { user: targetUser, rawToken: targetToken } = await createAuthedUser(
        "stage5_target@example.com"
      );
      createdUsers.push(targetUser.id);
      const targetStart = daysAgo(10 * MS_PER_DAY);
      const targetEnd = daysFromNow(20 * MS_PER_DAY);
      const targetSub = await prisma.subscription.create({
        data: {
          userId: targetUser.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: targetStart,
          currentPeriodEnd: targetEnd,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-target-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(targetSub.id);

      const quoteNoTarget = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie(targetToken) },
        body: JSON.stringify({}),
      });
      const quoteNoTargetJson = await quoteNoTarget.json();
      assert(
        quoteNoTarget.status === 200 && quoteNoTargetJson.targetPlan?.id === yearlyPlan.id,
        "Quote with no target resolves the active Yearly plan"
      );

      for (const [label, badPlanId] of [
        ["arbitrary", "cl00000000000000000000000"],
        ["Free plan", freePlan.id],
        ["Monthly plan", monthlyPlan.id],
      ]) {
        const badQuoteRes = await fetch("http://localhost:3000/api/subscriptions/upgrade/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: authCookie(targetToken) },
          body: JSON.stringify({ toPlanId: badPlanId }),
        });
        assert(
          badQuoteRes.status === 409,
          `Quote rejects ${label} target plan (got ${badQuoteRes.status})`
        );
      }

      // -------------------------------------------------------------
      // Test 25: Sequential duplicate initiate converges on one attempt
      // -------------------------------------------------------------
      console.log("\n--- Test 25: Sequential Duplicate Initiate (same attempt) ---");
      const targetInit1Res = await fetch(
        "http://localhost:3000/api/subscriptions/upgrade/initiate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: authCookie(targetToken) },
          body: JSON.stringify({}),
        }
      );
      const targetInit1 = await targetInit1Res.json();
      assert(
        targetInit1Res.status === 200 &&
          targetInit1.success === true &&
          targetInit1.targetPlan?.id === yearlyPlan.id,
        "Initiate with no target resolves the active Yearly plan (200 OK)"
      );
      assert(
        targetInit1.duplicate === false,
        "First initiate is recorded as a fresh attempt (duplicate=false)"
      );

      const targetBadInitRes = await fetch(
        "http://localhost:3000/api/subscriptions/upgrade/initiate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: authCookie(targetToken) },
          body: JSON.stringify({ toPlanId: "cl00000000000000000000000" }),
        }
      );
      assert(
        targetBadInitRes.status === 409,
        `Initiate rejects an arbitrary (non-Yearly) target plan (got ${targetBadInitRes.status})`
      );

      const targetInit2Res = await fetch(
        "http://localhost:3000/api/subscriptions/upgrade/initiate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: authCookie(targetToken) },
          body: JSON.stringify({}),
        }
      );
      const targetInit2 = await targetInit2Res.json();
      assert(
        targetInit2Res.status === 200 && targetInit2.duplicate === true,
        "Sequential duplicate initiate converges (duplicate=true)"
      );
      assert(
        targetInit2.reference === targetInit1.reference &&
          targetInit2.changeId === targetInit1.changeId,
        "Duplicate initiate reuses the SAME reference and change (no second Paystack attempt)"
      );
      assert(
        targetInit2.authorizationUrl === targetInit1.authorizationUrl,
        "Duplicate initiate returns the SAME authorization URL"
      );
      assert(
        (await prisma.subscriptionChange.count({
          where: { subscriptionId: targetSub.id, status: "pending" },
        })) === 1 &&
          (await prisma.paymentEvent.count({
            where: { subscriptionId: targetSub.id, eventType: "checkout.initiated" },
          })) === 1,
        "Sequential duplicates produce exactly one pending change and one checkout.initiated"
      );

      // -------------------------------------------------------------
      // Test 26: 5 concurrent initiates -> single pending upgrade reference
      // -------------------------------------------------------------
      console.log("\n--- Test 26: Concurrent Initiation (5x parallel, single attempt) ---");
      const { user: concUser2, rawToken: concToken2 } = await createAuthedUser(
        "stage5_conc2@example.com"
      );
      createdUsers.push(concUser2.id);
      const conc2Start = daysAgo(10 * MS_PER_DAY);
      const conc2End = daysFromNow(20 * MS_PER_DAY);
      const conc2Sub = await prisma.subscription.create({
        data: {
          userId: concUser2.id,
          planId: monthlyPlan.id,
          status: "active",
          currency: monthlyPlan.currency,
          amountMinor: monthlyPlan.amountMinor,
          currentPeriodStart: conc2Start,
          currentPeriodEnd: conc2End,
          cancelAtPeriodEnd: false,
          originatingPaymentReference: `pstk-stage5-conc2-${crypto.randomBytes(4).toString("hex")}`,
        },
      });
      createdSubs.push(conc2Sub.id);

      const conc2Results = await Promise.all(
        Array.from({ length: 5 }).map(() =>
          fetch("http://localhost:3000/api/subscriptions/upgrade/initiate", {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: authCookie(concToken2) },
            body: JSON.stringify({}),
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
        )
      );
      const conc2OkBodies = conc2Results.filter((r) => r.status === 200).map((r) => r.body);
      const conc2Conflicts = conc2Results.filter((r) => r.status === 409);
      assert(
        conc2OkBodies.length >= 1 &&
          conc2Results.every((r) => r.status === 200 || r.status === 409),
        `Concurrent initiates converge (200) or reject clearly (409): ${conc2Results
          .map((r) => r.status)
          .join(", ")}`
      );
      assert(
        conc2Conflicts.every((r) => typeof r.body?.error === "string" && r.body.error.length > 0),
        "Any 409 carries a clear conflict message"
      );
      const conc2Refs = new Set(conc2OkBodies.map((b) => b?.reference).filter(Boolean));
      const conc2ChangeIds = new Set(conc2OkBodies.map((b) => b?.changeId).filter(Boolean));
      const conc2Auths = new Set(conc2OkBodies.map((b) => b?.authorizationUrl).filter(Boolean));
      assert(conc2Refs.size === 1, "Concurrent initiates produce exactly ONE Paystack reference");
      assert(
        conc2ChangeIds.size === 1,
        "Concurrent initiates produce exactly ONE SubscriptionChange"
      );
      assert(conc2Auths.size === 1, "All converged responses share the same authorization URL");

      const conc2ChangeCount = await prisma.subscriptionChange.count({
        where: { subscriptionId: conc2Sub.id, changeType: "upgrade" },
      });
      const conc2PendingCount = await prisma.subscriptionChange.count({
        where: { subscriptionId: conc2Sub.id, status: "pending" },
      });
      const conc2EventCount = await prisma.paymentEvent.count({
        where: { subscriptionId: conc2Sub.id, eventType: "checkout.initiated" },
      });
      const conc2SubAfter = await prisma.subscription.findUnique({
        where: { id: conc2Sub.id },
      });
      assert(
        conc2ChangeCount === 1 && conc2PendingCount === 1,
        `Only one SubscriptionChange row exists, still pending (${conc2ChangeCount}/${conc2PendingCount})`
      );
      assert(
        conc2EventCount === 1,
        `No duplicate Paystack initiation: exactly one checkout.initiated (${conc2EventCount})`
      );
      assert(
        conc2SubAfter?.pendingUpgradeReference === [...conc2Refs][0],
        "Subscription carries exactly the one pending upgrade reference"
      );

      // -------------------------------------------------------------
      // Cleanup
      // -------------------------------------------------------------
      console.log("\nCleaning up Stage 5 test records...");
      await prisma.subscriptionChange.deleteMany({
        where: { subscriptionId: { in: createdSubs } },
      });
      await prisma.paymentEvent.deleteMany({
        where: { userId: { in: createdUsers } },
      });
      await prisma.subscription.deleteMany({
        where: { id: { in: createdSubs } },
      });
      await prisma.session.deleteMany({
        where: { userId: { in: createdUsers } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUsers } },
      });
    } catch (e) {
      console.error("Stage 5 verification exception:", e);
      failed++;
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.error("Verification failed with exception:", err);
    failed++;
    await prisma.$disconnect();
  }

  console.log("\n=======================================================================");
  console.log(`STAGE 5 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runStage5Verification();