# Payment-Subscription-Slice — Documentation

---

## 1. Project Overview

### Purpose

This is a self-contained payment and subscription management slice built on top of an existing authenticated Next.js application. It demonstrates the full lifecycle of a SaaS-style subscription: plan selection, Paystack-hosted checkout, server-side payment verification, subscription fulfilment, plan changes (upgrade and downgrade), and cancellation at period end. The implementation is intentionally backend-first: all pricing, amounts, and subscription state are derived server-side from the database; the client never supplies a trusted amount.

### Stack and Architecture

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Server Components, Route Handlers) |
| ORM | Prisma |
| Database | SQLite (`prisma/dev.db`) |
| Payment Provider | Paystack (test mode) |
| Language | TypeScript |
| Runtime | Node.js |

The application is structured around three layers:

1. **Service libraries** (`src/lib/`) — domain logic for fulfilment, upgrades, downgrades, cancellations, proration, and subscriptions. No HTTP concerns.
2. **API Route Handlers** (`src/app/api/`) — authenticate the caller, validate input with Zod schemas, delegate to service libraries, and return JSON.
3. **UI pages and client components** (`src/app/`) — Server Components fetch subscription state; Client Components handle user actions via `fetch` calls to the API routes.

### Main Responsibilities

- Define and seed subscription plans (Free, Monthly, Yearly).
- Initiate Paystack-hosted checkout sessions and record an audit event at initiation time.
- Verify completed payments server-side against Paystack's API and via HMAC-authenticated webhooks.
- Fulfil verified payments into `Subscription` records atomically, with idempotency protection.
- Process Monthly → Yearly prorated upgrades through an additional Paystack charge.
- Schedule Yearly → Monthly downgrades to take effect at the current period end.
- Schedule and apply cancellations at period end without immediate service termination.
- Expose a dashboard billing view and payment history drawn from the immutable `PaymentEvent` audit trail.

---

## 2. Plans and Pricing

### Plan Definitions

Three plans are defined in `prisma/seed.ts` and loaded into the `plans` table via `prisma db seed`:

| Name | Interval | Amount (minor units) | Currency | Notes |
|---|---|---|---|---|
| Free | `free` | 0 | NGN | No checkout; no fulfilment required |
| Monthly | `monthly` | 500,000 kobo | NGN | ₦5,000 per month |
| Yearly | `yearly` | 5,000,000 kobo | NGN | ₦50,000 per year |

Minor units (kobo) are stored as integers throughout the codebase. The `formatPrice` function in `src/lib/subscriptions.ts` converts them to display strings using `Intl.NumberFormat`.

### Database Approach

Plans are created via `upsert` keyed on `@@unique([name, interval])`. Running the seed multiple times is safe; it updates existing records rather than creating duplicates.

The `Plan` model (`prisma/schema.prisma`) stores:

- `name` / `interval` — unique together
- `amountMinor` (Int) — authoritative; never sourced from the client
- `currency` — `"NGN"` for all seeded plans
- `providerPlanCode` — nullable; reserved for provider-side plan codes
- `active` (Boolean) — only active plans appear in the plans view

### Active Plan Handling

`getActivePlans()` in `src/lib/subscriptions.ts` fetches all plans where `active = true`, ordered by `amountMinor` ascending. The plans page (`src/app/plans/page.tsx`) calls this function and derives current plan state from `getUserActiveSubscription()` to determine which actions are available per card.

---

## 3. Paystack Checkout and Payment Verification

### Checkout Initiation — `POST /api/checkout/initiate`

File: `src/app/api/checkout/initiate/route.ts`

The route:

1. Applies IP-level and user-level rate limiting (`checkRateLimit`).
2. Authenticates the session with `getCurrentUser()`.
3. Validates the request body against `checkoutInitiateSchema` (Zod).
4. Looks up the requested plan from the database. The client supplies only a `planId`; pricing is read from the `Plan` record.
5. Rejects Free plan checkouts and plans with an unsupported interval.
6. Rejects users who already have an active paid subscription (guard for the initial flow).
7. Generates a unique `reference` via `generateCheckoutReference()` in `src/lib/paystack.ts`.
8. Calls `initializePaystackTransaction()`, passing the DB amount, currency, reference, and a callback URL of the form `{APP_URL}/plans?checkout_status=completed&reference={reference}`.
9. Records an immutable `PaymentEvent` with `eventType = "checkout.initiated"` and `status = "pending"`. No subscription or entitlement is granted at this point.
10. Returns `{ authorizationUrl, reference, accessCode }` to the client.

### Paystack Reference Handling

The reference is generated locally, included in the Paystack initialisation call, and embedded in the callback URL. It is the durable key linking all subsequent events: `checkout.initiated`, `payment.verified`, and `payment.fulfilled`.

### Server-Side Verification — `POST /api/checkout/verify`

File: `src/app/api/checkout/verify/route.ts`

After Paystack redirects back to `/plans?checkout_status=completed&reference=...`, the plans page detects the query parameters and posts the reference to this route. The route:

1. Applies rate limiting and authenticates the caller.
2. Validates the request body against `checkoutVerifySchema`.
3. Looks up the `checkout.initiated` event by reference and asserts ownership (`userId` must match the session user).
4. Detects whether this is an upgrade payment; if so, the expected amount is the stored `chargeMinor` from the `SubscriptionChange` record, not the full Yearly plan amount.
5. Performs an idempotency pre-check: if a `payment.verified` event already exists for this reference, it re-runs fulfilment and returns early.
6. Calls `verifyPaystackTransaction(reference)` (server-to-Paystack API call).
7. Runs integrity checks: domain must be `"test"`, reference, amount, and currency must match expectations.
8. Maps provider status: `pending`/`ongoing`/`processing` return without recording failure; `reversed` creates a `payment.reversed` event; any non-success creates a `payment.failed` event.
9. On `success`: creates a `payment.verified` event (`status = "verified"`) using a `@@unique` constraint to protect against concurrent writes.
10. Calls `fulfilVerifiedPayment()` (from `src/lib/upgrades.ts`) to activate the subscription or apply the upgrade.

### Callback / Return Flow

The callback URL is `{APP_URL}/plans?checkout_status=completed&reference={reference}`. The plans page (`src/app/plans/page.tsx`) reads these query parameters and, if `checkout_status === "completed"`, triggers a client-side call to `POST /api/checkout/verify`.

### Webhook Handling — `POST /api/webhooks/paystack`

File: `src/app/api/webhooks/paystack/route.ts`

1. Reads the raw request body as text (required for HMAC calculation).
2. Verifies the `x-paystack-signature` header using HMAC-SHA512 with `PAYSTACK_SECRET_KEY` via `verifyPaystackSignature()`. Requests with invalid signatures return `401`.
3. Handles `charge.success` events only; all other event types are acknowledged with `200 OK`.
4. Checks idempotency: if a `payment.verified` event already exists for this reference, re-runs `fulfilVerifiedPayment()` and returns early.
5. Resolves the `userId` and `planId` from the stored `checkout.initiated` record or from `txData.metadata`.
6. Validates amount and currency, accounting for upgrade prorations.
7. Creates a `payment.verified` event with P2002 concurrency safety.
8. Calls `fulfilVerifiedPayment()` to create or update the subscription.

### Idempotency and Validation

The `PaymentEvent` table has a composite unique index `@@unique([provider, providerReference, eventType])`. This means creating a duplicate `payment.verified` event for the same reference raises Prisma error `P2002`, which is caught and treated as an idempotent success in all write paths. Both the verify route and the webhook handler check for an existing `payment.verified` event before calling Paystack, preventing unnecessary API round-trips on retries.

### PaymentEvent Audit Trail

Every state transition during payment generates an immutable `PaymentEvent` row:

| `eventType` | Created by | Meaning |
|---|---|---|
| `checkout.initiated` | `/api/checkout/initiate` | Session created with Paystack; no payment yet |
| `payment.verified` | `/api/checkout/verify` or webhook | Paystack confirmed the charge; amount and reference match |
| `payment.fulfilled` | `fulfilSubscription()` in `src/lib/fulfilment.ts` | Subscription record created; entitlement granted |
| `payment.failed` | Verify route / webhook | Integrity or provider status failure |
| `payment.reversed` | Verify route / webhook | Provider-reversed transaction |

---

## 4. Subscription Fulfilment

### Verified Payment → Subscription

Fulfilment is performed by `fulfilSubscription()` in `src/lib/fulfilment.ts`. The function is called from `fulfilVerifiedPayment()` in `src/lib/upgrades.ts`, which dispatches to either `fulfilSubscription()` (new subscriptions) or the upgrade application path depending on whether a `SubscriptionChange` record exists.

The fulfilment sequence:

1. **Idempotency check**: query `Subscription` by `originatingPaymentReference`. If found, return it immediately (`idempotent: true`).
2. **Verify `checkout.initiated` exists** for the reference.
3. **Verify `payment.verified` exists** with `status = "verified"`.
4. **Resolve the plan** from `planId` stored in the event payload.
5. **Assert amount and currency** from the verified event match the plan record.
6. **Active subscription protection**: reject if the user already has an active subscription (conflict path; upgrades use a separate path in `src/lib/upgrades.ts`).
7. **Calculate period dates** using `calculateSubscriptionPeriod()`.
8. **Create the `Subscription`** row with `originatingPaymentReference` (unique column).
9. **Create the `payment.fulfilled` event** linking to the new subscription.

### Period Calculation

`calculateSubscriptionPeriod(startDate, interval)` in `src/lib/fulfilment.ts`:

- **Monthly**: adds exactly 1 calendar month, clamping the day to the last valid day if the target month is shorter (e.g. 31 Jan → 28/29 Feb).
- **Yearly**: adds exactly 1 calendar year, clamping Feb 29 in non-leap years.
- All dates are computed in UTC to avoid DST drift.

### Active Subscription Protection

The initial fulfilment path (`fulfilSubscription`) rejects any attempt to overwrite an active subscription with `conflict: true`. The upgrade path in `src/lib/upgrades.ts` replaces the plan inline under a transaction after verifying eligibility — it does not go through the basic conflict check.

### Payment Fulfilment Event

After creating the subscription, `fulfilSubscription()` writes a `payment.fulfilled` `PaymentEvent` with:

- `eventType = "payment.fulfilled"`, `status = "fulfilled"`
- `subscriptionId` linking to the new subscription
- A payload containing `subscriptionId`, `planId`, `planName`, `interval`, `currentPeriodStart`, and `currentPeriodEnd`

### Idempotency

Two layers of idempotency protect concurrent or retried calls:

1. **Application-level**: early return if `Subscription.originatingPaymentReference` is already present.
2. **Database-level**: `@unique originatingPaymentReference` on `Subscription`; P2002 errors are caught and resolved by querying the committed row.

---

## 5. Subscription Changes

### Monthly → Yearly Upgrade

The upgrade flow is implemented in `src/lib/upgrades.ts` and exposed at `POST /api/subscriptions/upgrade`.

**Eligibility** (`resolveUpgradeEligibility`):

- User must have an active Monthly subscription within its billing period.
- Target plan must be the active Yearly plan (resolved server-side; client-supplied `toPlanId` is treated only as an assertion).
- Plans must share the same currency.
- A pending upgrade must not already exist for this subscription.

**Proration** (`calculateUpgradeProration` in `src/lib/proration.ts`):

```
creditMinor  = round(oldPeriodAmountMinor × daysRemaining / currentPeriodDays)
chargeMinor  = newPeriodAmountMinor − creditMinor
```

All arithmetic is in integer minor units. Rounding uses standard half-up. Example: ₦5,000 monthly plan, 30-day period, 18 days remaining → credit = ₦3,000, charge = ₦47,000.

**Flow**:

1. `scheduleUpgrade()` creates a `SubscriptionChange` (`changeType = "upgrade"`, `status = "pending"`) and a `checkout.initiated` event for the prorated charge.
2. A new Paystack transaction is initialised for `chargeMinor`.
3. After the user pays, the verify route detects the pending `SubscriptionChange` via `resolveUpgradeChangeForInitiated()` and validates against `chargeMinor` (not the full Yearly price).
4. `applyUpgrade()` transitions the subscription to Yearly, calculates a new period starting from the upgrade date, marks the `SubscriptionChange` as `"applied"`, and records a `payment.fulfilled` event.

### Server-Side Proration

`calculateUpgradeProration()` receives server-derived values only: `oldPeriodAmountMinor`, `newPeriodAmountMinor`, `currentPeriodStart`, `currentPeriodEnd`, and `now`. The client never supplies an amount.

### Yearly → Monthly Scheduled Downgrade

Implemented in `src/lib/downgrades.ts` and exposed at `POST /api/subscriptions/downgrade`.

**Eligibility** (`resolveDowngradeEligibility`):

- User must have an active Yearly subscription.
- Target plan must be the active Monthly plan (server-resolved).
- Subscription must not already be scheduled for cancellation (`cancelAtPeriodEnd = false`).
- No payment is taken.

**Scheduling** (`scheduleDowngrade`):

- Creates a `SubscriptionChange` with `changeType = "downgrade"`, `status = "pending"`, `effectiveAt = currentPeriodEnd`.
- `creditMinor = 0`, `chargeMinor = 0` (no money moves at scheduling time).
- The Yearly subscription remains active until `currentPeriodEnd`.

### Effective-at-Period-End Behaviour

`applyDueSubscriptionChanges()` in `src/lib/downgrades.ts` is designed to be called by a server-side scheduler. It:

1. Queries all `SubscriptionChange` records with `status = "pending"`, `changeType = "downgrade"`, and `effectiveAt ≤ now`.
2. Skips changes if the subscription has been cancelled, changed plan, or `cancelAtPeriodEnd = true`.
3. Calls `calculateSubscriptionPeriod` from the old `currentPeriodEnd` to compute the new Monthly period.
4. Updates the subscription's `planId`, `amountMinor`, `currency`, and period dates atomically.
5. Marks the `SubscriptionChange` as `"applied"`.
6. After processing downgrades, calls `applyDueCancellations()`.

### Concurrency / Idempotency Protections

- **Within a transaction**: `scheduleDowngrade()` and `scheduleUpgrade()` check for an existing pending change before creating a new one. If found with the same target plan, the existing change is returned (`idempotent: true`). If a different pending change exists, a `409` is raised.
- **Race condition (P2002)**: if two concurrent requests both pass the pre-check and one wins the insert, the loser catches `P2002` and re-fetches the committed change.
- **Apply-phase guard**: `applyDueSubscriptionChanges()` uses `updateMany` with a WHERE clause asserting `status = "active"` and `planId = fromPlanId` before transitioning, so stale or concurrently modified subscriptions are skipped.

### SubscriptionChange Records

Model: `SubscriptionChange` (`subscription_changes` table):

| Field | Purpose |
|---|---|
| `subscriptionId` | FK to the parent subscription |
| `fromPlanId` / `toPlanId` | FK to `Plan` (via `"FromPlan"` / `"ToPlan"` relations) |
| `changeType` | `"upgrade"` or `"downgrade"` |
| `effectiveAt` | Timestamp when the change should take effect |
| `daysRemaining` | Remaining days at scheduling time |
| `creditMinor` / `chargeMinor` | Proration amounts (in kobo); zero for downgrades |
| `currency` | Currency code |
| `status` | `"pending"` → `"applied"` or `"cancelled"` |

---

## 6. Cancellation

### Cancellation at Period End

Implemented in `src/lib/cancellations.ts` and exposed at `POST /api/subscriptions/cancel`.

**Effect of cancellation**:

- `Subscription.cancelAtPeriodEnd` is set to `true`.
- `Subscription.cancelledAt` records the timestamp of the cancellation request.
- `Subscription.cancellationReason` stores an optional user-supplied reason (trimmed; null if blank).
- `Subscription.status` remains `"active"`.
- `Subscription.currentPeriodEnd` is not modified.
- No refund is issued. No payment is created.

### Access Remains Active Until `currentPeriodEnd`

`getUserActiveSubscription()` checks `status = "active"`, `currentPeriodStart ≤ now`, and `currentPeriodEnd ≥ now`. A subscription with `cancelAtPeriodEnd = true` continues to satisfy this query until its period ends, so the user retains access for the remainder of the period they have paid for.

### Cancellation State in the UI

The plans page and dashboard both read `cancelAtPeriodEnd` from the active subscription:

- Plans page (`src/app/plans/page.tsx`): the current plan card shows a `"Cancellation Scheduled"` badge and the cancellation button is disabled.
- Dashboard (`src/app/dashboard/page.tsx`): the Billing Information card shows an amber `"Cancels at period end"` badge and relabels the period-end field as `"Access Until"`.

### Optional Cancellation Reason

`scheduleCancellation(userId, reason?, now?)` accepts an optional `reason` string. The `subscriptionCancelSchema` (Zod, in `src/lib/validation/checkout.ts`) validates and trims it. A blank or absent reason stores `null`.

### Cancellation Idempotency

`scheduleCancellation()` checks `cancelAtPeriodEnd` before entering the transaction (fast-path). Inside the transaction, after acquiring the row, it re-checks the flag (double-checked locking). If cancellation is already scheduled, the function returns `{ subscription, idempotent: true }` without modifying anything.

### Interaction Between Cancellation and Pending Downgrade

When a cancellation is scheduled, `scheduleCancellation()` transitions all `SubscriptionChange` records with `status = "pending"` for that subscription to `status = "cancelled"`. This ensures a Stage 6 downgrade does not erroneously execute after the subscription period ends.

`applyDueSubscriptionChanges()` enforces this in the apply phase as well: it skips any pending change where `subscription.cancelAtPeriodEnd = true`.

### Applying Due Cancellations

`applyDueCancellations(now)` in `src/lib/cancellations.ts`:

1. Queries all subscriptions with `status = "active"`, `cancelAtPeriodEnd = true`, and `currentPeriodEnd ≤ now`.
2. For each, within a transaction:
   - Transitions any remaining `"pending"` `SubscriptionChange` records to `"cancelled"`.
   - Updates `Subscription.status` from `"active"` to `"cancelled"`.
3. Called automatically at the end of `applyDueSubscriptionChanges()` in `src/lib/downgrades.ts`.

---

## 7. Billing View and Payment Audit Trail

### Current Plan

The dashboard (`src/app/dashboard/page.tsx`) calls `getUserActiveSubscription(user.id)` and displays the plan name in a badge. If no active subscription exists, it displays `"Free"`.

### Billing Information Card

The card (`id="billing-details-card"`) is rendered only when an active subscription exists. It shows:

| Field | Source |
|---|---|
| Status badge | `cancelAtPeriodEnd` → amber `"Cancels at period end"` or green `subscription.status` |
| Plan Rate | `formatPrice(amountMinor, currency)` + `/ {interval}` |
| Current Period Start | `subscription.currentPeriodStart` |
| Renewal / Access Until | `subscription.currentPeriodEnd` (label changes based on `cancelAtPeriodEnd`) |

### Cancellation State

When `cancelAtPeriodEnd = true`:

- Status badge changes to amber `"Cancels at period end"`.
- `"Renewal / Period End"` is relabelled `"Access Until"`.
- The `CancelSubscriptionAction` client component renders a disabled `"Cancellation Scheduled"` button.

### Payment History UI

The dashboard includes a `"Payment History"` card (`id="payment-history-card"`) rendered when `paymentHistory.length > 0`. It is populated by `getUserPaymentHistory(user.id)` from `src/lib/subscriptions.ts`, which queries `PaymentEvent` ordered by `createdAt` descending.

Each entry displays:

| UI field | Data source |
|---|---|
| Human-readable event name | `formatEventType(eventType)` — maps `"checkout.initiated"` → `"Checkout Initiated"`, etc. |
| Status badge | Colour-coded by `getStatusBadgeClass(status)` (emerald for verified/fulfilled, amber for pending, red for failed, purple for reversed) |
| Amount | `formatPrice(amountMinor, currency)` |
| Provider Reference | `providerReference` (monospaced, selectable) |
| Date & Time | `processedAt ?? createdAt` formatted with `Intl.DateTimeFormat` |

### PaymentEvent Records

Three event types form the standard successful payment audit trail:

**`checkout.initiated`** — created by `POST /api/checkout/initiate` at the moment the user is sent to Paystack. Proves that a checkout session was started with a specific plan and amount.

**`payment.verified`** — created by `POST /api/checkout/verify` or `POST /api/webhooks/paystack` after Paystack confirms the charge. Proves the provider reported success and the server independently confirmed amount and currency integrity.

**`payment.fulfilled`** — created by `fulfilSubscription()` at the moment the `Subscription` row is written. Proves that the application granted entitlement and links the event to the resulting `Subscription` via `subscriptionId`.

### Traceability and Dispute Review

The `PaymentEvent` table is append-only by application design: events are never deleted or updated after creation. The `@@unique([provider, providerReference, eventType])` constraint prevents duplicate records for any given stage of a transaction. Together, these three events create a verifiable chain:

1. When did the user initiate checkout and for which plan?
2. Did the provider confirm payment and what was the confirmed amount?
3. Was access actually granted and for which subscription period?

This trail supports dispute investigation (e.g. confirming a payment succeeded before the subscription was created), re-processing audits (idempotency evidence), and customer support queries about billing history.

---

## 8. Verification Evidence and Known Limitations

### TypeScript Validation

```
pnpm exec tsc --noEmit
```

**Result**: exit code 0, no errors. Run on 2026-09-20 against all source files including the two uncommitted files carrying the Payment History feature (`src/app/dashboard/page.tsx`, `src/lib/subscriptions.ts`).

### Lint Validation

```
pnpm run lint
```

**Result**: exit code 0, no warnings or errors (ESLint).

### Git Verification

Last 10 commits on `main` at documentation time:

```
8f07b21 Harden scheduled downgrade processing
d4323e8 Complete subscription cancellation at period end
08544ba Implement yearly to monthly downgrade
08a2473 Remove accidentally committed Stage 5 report
96b3984 Implement prorated monthly to yearly upgrade
79eb44b Fulfill verified payments into subscriptions
c08ca75 Add payment verification and webhook handling
604cd81 Configure Paystack test checkout
0aadfb3 Add subscription plans and plans view
b7189df Set up subscription payment data model
```

Git status shows two unstaged files: `src/app/dashboard/page.tsx` and `src/lib/subscriptions.ts` (Payment History feature). These are complete and pass TypeScript and lint checks but have not yet been committed.

### Integration / Lifecycle Tests Run

The following lifecycle scenarios were executed manually against the development server with a Paystack test-mode account:

- **Stage 1**: Plans page renders Free, Monthly, and Yearly cards.
- **Stage 2**: Checkout initiation returns an `authorizationUrl`; user is redirected to Paystack.
- **Stage 3**: Returning from Paystack triggers `POST /api/checkout/verify`; `payment.verified` and `payment.fulfilled` events confirmed in Prisma Studio.
- **Stage 4**: Dashboard and plans page reflect the active subscription; re-submitting the same reference returns idempotently without creating a duplicate.
- **Stage 5**: Monthly → Yearly prorated upgrade: prorated charge presented; Paystack test payment completes; subscription updated to Yearly.
- **Stage 6**: Yearly → Monthly downgrade scheduled; plans page shows `"Downgrade Scheduled"` badge on page refresh; re-clicking is blocked by idempotency check.
- **Stage 7**: Cancellation scheduled; `cancelAtPeriodEnd = true` confirmed in Prisma Studio; cancellation state visible on both plans page and dashboard; pre-existing pending downgrade invalidated.
- **Payment History**: Dashboard shows `checkout.initiated`, `payment.verified`, and `payment.fulfilled` events with correct amounts, references, and timestamps.

A scripted lifecycle test was also executed from `scratch/test-stage-7.ts`, verifying the cancellation and downgrade interaction at the database layer.

### Browser / Manual Verification

Manual browser verification performed in Chrome against `http://localhost:3000` for:

- Plans page card states: unauthenticated, free, monthly active, yearly active, downgrade-scheduled, and cancellation-scheduled.
- Dashboard: Billing Information card with and without `cancelAtPeriodEnd`; Payment History card with multiple events.
- `CancelSubscriptionAction` component: enabled for an active paid subscription, disabled when cancellation is already scheduled.

### Known Limitations and Assumptions

- **No built-in scheduler**: `applyDueSubscriptionChanges()` and `applyDueCancellations()` must be triggered externally (e.g. a cron HTTP call). There is no background task engine in the application.
- **Single active subscription per user**: the fulfilment and upgrade logic assume at most one active paid subscription per user at a time.
- **Paystack test mode only**: the verify route asserts `txData.domain === "test"`. Moving to live mode requires replacing environment variables and updating that assertion.
- **SQLite write locks**: under concurrent write pressure, write queuing may cause latency. Changing the Prisma provider to `postgresql` and updating `DATABASE_URL` is the full migration path.
- **In-memory rate limiting**: rate limit state does not persist across server restarts or scale across multiple processes.
- **No automated test suite**: no unit or integration tests are committed. The service functions are structured for testability but tests were not written as part of this assessment.
- **Webhook endpoint registration**: `POST /api/webhooks/paystack` requires manual registration in the Paystack dashboard with an externally reachable URL to receive live events.
