# Stage 5 Report: Monthly → Yearly Upgrade with Server-Side Proration

**Date:** 2026-09-19
**Project:** Payment-Subscription-Slice
**Stack:** Next.js 16.3.5 (App Router, Turbopack) · TypeScript · Prisma 6.4.0 · SQLite · Paystack (test mode) · Zod

---

## 1. Files Changed

### Created

| File | Purpose |
|---|---|
| `src/lib/proration.ts` | Pure math helpers: `calculateUpgradeProration`, `getCalendarPeriodDays`, `getDaysRemaining`, `MS_PER_DAY` |
| `src/lib/upgrades.ts` | Server-controlled target resolution, upgrade eligibility checks, server-side quote, concurrency-guarded `initiateUpgradeCheckout` (claim → pending change → real Paystack init), `applyUpgrade` fulfilment, `fulfilVerifiedPayment` dispatcher |
| `src/app/api/subscriptions/upgrade/quote/route.ts` | `POST /api/subscriptions/upgrade/quote` — read-only proration preview |
| `src/app/api/subscriptions/upgrade/initiate/route.ts` | `POST /api/subscriptions/upgrade/initiate` — server-controlled initiate: DB-atomic claim, persists pending `SubscriptionChange`, real Paystack one-time init with exact `chargeMinor`; converges or 409s on duplicates |
| `src/app/plans/upgrade-card-action.tsx` | Client component: fetch quote → show breakdown → "Confirm Upgrade & Pay" → redirect to Paystack `authorizationUrl`. Sends no target plan — the server controls it |
| `scripts/verify-stage5.mjs` | 113-assertion Stage 5 verification suite |

### Modified

| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `Subscription.pendingUpgradeReference String?` (forward-only claim column, see §2) |
| `src/lib/validation/checkout.ts` | Added `upgradeQuoteSchema` and `upgradeInitiateSchema` |
| `src/app/api/checkout/verify/route.ts` | Upgrade-aware: for upgrades, `expectedAmountMinor`/`expectedCurrency` read from the `SubscriptionChange`; success and duplicate paths call `fulfilVerifiedPayment` |
| `src/app/api/webhooks/paystack/route.ts` | Same dispatcher; amount/currency check uses `change.chargeMinor` for upgrades instead of `plan.amountMinor` |
| `src/app/plans/page.tsx` | Computes `isUpgradeEligible` (active Monthly, paid, not `cancelAtPeriodEnd`) and passes `upgradeFromMonthly` to the Yearly card |
| `src/app/plans/plan-card-action.tsx` | Renders `UpgradeCardAction` when `upgradeFromMonthly` is true |

---

## 2. Prisma Schema Changes

**One forward-only change** (applied via `prisma db push`, database not reset):

- Added `Subscription.pendingUpgradeReference String?` — the per-subscription claim holding the (single) reserved Paystack reference for a pending upgrade checkout. It is `null` normally, set atomically when an upgrade initiate wins the race, and cleared on verified fulfilment (or on initiation failure). Because it is a column on the subscription row, a subscription can only ever carry **at most one** pending upgrade attempt.

No other migration was required:

- `SubscriptionChange` already carried `fromPlanId`, `toPlanId`, `changeType`, `status`, `effectiveAt`, `daysRemaining`, `oldPeriodAmountMinor`, `newPeriodAmountMinor`, `creditMinor`, `chargeMinor`, `currency`.
- `PaymentEvent` already had the unique constraint `(provider, providerReference, eventType)` used for idempotency.

---

## 3. Exact Proration Formula

Integer minor units (kobo), half-up rounding everywhere:

```
periodDays       = Math.round((periodEnd − periodStart) / 86_400_000)          // whole calendar days
daysRemaining    = clamp(Math.ceil((periodEnd − now) / 86_400_000), 0, periodDays)

creditMinor      = Math.round(oldPeriodAmountMinor × daysRemaining / periodDays)
chargeMinor      = newPeriodAmountMinor − creditMinor
```

Day-convention decisions:

- A period running Jan 1 → Jan 31 is exactly **30** days.
- The current partial day is credited **in full** (`Math.ceil`).
- At exact period start, `daysRemaining = periodDays` (full credit).
- At exact period end, `daysRemaining = 0` (no credit).
- Result is clamped to `[0, periodDays]` to survive clock skew between `currentPeriodStart`/`currentPeriodEnd` setup.

---

## 4. Actual Test Example

| | |
|---|---|
| Old plan | Monthly @ 500 000 kobo = NGN 5 000 |
| New plan | Yearly @ 5 000 000 kobo = NGN 50 000 |
| Period days | 30 |
| Days remaining | 18 (upgrade on day 12) |
| **Credit** | 500 000 × 18 ÷ 30 = **300 000 kobo** (NGN 3 000) |
| **Charge today** | 5 000 000 − 300 000 = **4 700 000 kobo** (NGN 47 000) |
| Real live-run example (Test 8, day 10 of 30) | `creditMinor = 333 333`, `chargeMinor = 4 666 667` |

Verified both as a pure function (`calcUpgradeProration` in `src/lib/proration.ts`) and through the live HTTP quote endpoint.

---

## 5. Upgrade Payment Representation in `PaymentEvent`

| `eventType` | When | `amountMinor` | `status` | Key payload fields |
|---|---|---|---|---|
| `checkout.initiated` | On initiate (winner only) | `chargeMinor` | `pending` | `changeType:"upgrade"`, `changeId`, `subscriptionId`, `creditMinor`, `daysRemaining`, `authorizationUrl` |
| `payment.verified` | After Paystack verification | `chargeMinor` | `verified` | Paystack response fields; `subscriptionId` stays `null` (immutable row) |
| `payment.fulfilled` | After plan flip | `chargeMinor` | `fulfilled` | Includes the resulting `subscriptionId` |
| `payment.failed` | Amount/currency mismatch | `chargeMinor` | `failed` | Rejection reason in payload |

Notes:

- No `plan` / `plan_code` appears in any payload; the Paystack initializer never sends a plan, so Paystack can never substitute its configured plan amount.
- Append-only immutability preserved: verified/initiated rows are never mutated to attach a `subscriptionId`; payload evidence is stored in the `payload` column (there is no hash column on `PaymentEvent`) and the unique `(provider, providerReference, eventType)` constraint prevents duplication.

---

## 6. SubscriptionChange Persistence

1. **Initiate** — `initiateUpgradeCheckout` resolves the **active Yearly plan from the database** (the target is fully server-controlled; a client-supplied target id is only an assertion and anything else is rejected), recomputes eligibility + proration server-side, then:
   - **Claims** the subscription via an atomic `updateMany({ where: { id, pendingUpgradeReference: null } })` holding the new provider reference. Exactly one concurrent request wins.
   - **Persists one `SubscriptionChange`** as the winner: `fromPlanId = Monthly`, `toPlanId = Yearly`, `changeType = "upgrade"`, `status = "pending"`, `effectiveAt = now()`, `oldPeriodAmountMinor`/`newPeriodAmountMinor`/`creditMinor`/`chargeMinor`/`currency`.
   - Creates the one-time Paystack transaction for the exact `chargeMinor` and records `checkout.initiated`.
   - Losers converge on the winner's attempt (same reference, same authorization URL) or receive a clear `409`; no second Paystack reference can ever exist for a pending upgrade.
   - **Failure handling — two distinct paths.** (a) If Paystack initialization fails *before* a transaction exists, the claim is released and the pending change is removed so a retry can start completely fresh. (b) If Paystack initialization *succeeds* but a subsequent local persistence step fails, the claim and pending change are **retained** (never released, change never deleted), and the `checkout.initiated` evidence is best-effort re-persisted on the same reference — a retry therefore converges on the same Paystack transaction and can never open a second independent transaction for the same pending upgrade.
2. **Fulfil** (first of webhook / browser-verify to win) — `applyUpgrade` flips the existing `Subscription.planId`, `amountMinor`, `currency`, resets the period (starts now, ends exactly one calendar year later), **clears `pendingUpgradeReference`**, and marks the change `status = "applied"`.
3. **Rejected** — a wrong amount/currency records `payment.failed` and leaves the change `pending`; no plan change occurs.

---

## 7. Duplicate & Concurrent Processing Prevention

| Layer | Mechanism |
|---|---|
| **Webhook signature** | HMAC-SHA512 over the raw body using `PAYSTACK_SECRET_KEY`; invalid signatures rejected before any processing |
| **Initiate claim guard** | `Subscription.pendingUpgradeReference` claimed with a DB-atomic conditional `updateMany` **before** any Paystack call; exactly one request wins the claim, so at most one pending change and one Paystack reference can exist per subscription (duplicates converge on the same attempt or get a 409) |
| **Idempotent events** | `PaymentEvent` unique `(provider, providerReference, eventType)`; P2002 duplicate-key errors are caught and treated as already-processed |
| **Plan-flip race** | `applyUpgrade` uses a conditional `updateMany` with `where: { id, planId: fromPlanId, status: "active" }` — only one concurrent request observes `count === 1` and wins; the rest skip |
| **Verify ↔ webhook convergence** | Both converge on `fulfilVerifiedPayment`; the first to arrive creates `payment.fulfilled` + applies the change; the second returns `{ idempotent: true }` |
| **Trusted amounts & target** | Client-supplied `amountMinor`/`creditMinor`/`daysRemaining` are ignored; the server derives amounts from the DB, resolves the active Yearly plan itself, treats a supplied `toPlanId` only as an assertion, and rejects anything else |

Test coverage: sequential duplicate initiate, 5× concurrent initiates, duplicate webhook, 5× parallel webhook deliveries, browser-after-webhook, webhook-after-browser — each produced exactly one verified event, one fulfilled event, one applied change, one pending upgrade claim/reference, and no second `Subscription` row.

---

## 8. Exact Test Results

All suites run against the live dev server (`http://localhost:3000`), database, and real Paystack test API:

| Suite | Passed | Failed | Coverage |
|---|---|---|---|
| `scripts/verify-stage2.mjs` | 29 | 0 | API key guards, reference format, real Paystack init |
| `scripts/verify-stage3.mjs` | 25 | 0 | Browser/webhook happy path, lifecycle events, browser-only forbidden |
| `scripts/verify-stage4.mjs` | 34 | 0 | Monthly/Yearly fulfilment, repeating fulfilment idempotency, concurrency race safety, no user-level entitlement flags |
| `scripts/verify-stage5.mjs` | 113 | 0 | Proration math boundaries; fail-closed rejections (no-subscription, Free, Yearly, `cancelAtPeriodEnd`, expired period); exact live quote; read-only quote; server-controlled target (no-target → active Yearly, arbitrary/Free/Monthly targets rejected); initiate with real Paystack redirect; persisted change/event integrity; webhook fulfilment; **claim released on fulfilment**; duplicate initiate idempotency; **5× concurrent initiates → exactly one reference / one pending change / one `checkout.initiated`**; duplicate webhook idempotency; browser/webhook convergence in both orders; 5× concurrent deliveries; wrong amount/currency rejected; uninitiated/browser-only forbidden; no user-level flags |
| **Total** | **201** | **0** | |

Quality gates: `npx tsc --noEmit` (clean), `npm run lint` / `npx eslint .` (0 errors / 0 warnings), `npm run build` (passes), `npm run db:generate` + `npm run db:push` (applied the one `pendingUpgradeReference` column).

---

## 9. Limitations

- **Browser verification cannot exercise the real Paystack checkout.** The test suite simulates the browser-first path by inserting `payment.verified` directly (the idempotency/convergence logic is what is under test), since a real Paystack hosted checkout cannot be driven headlessly in a test.
- **Lapsed-period fulfilment.** The expiry guard at the quote/initiate stage (409) is tested, but a subscription that expires between initiate and webhook is handled by the same period-end guard in `fulfilVerifiedPayment`. The quote/initiate expiry path is covered; no dedicated test covers the mid-flight expiry race.
- **Abandoned checkout keeps the claim.** If a user initiates and never pays, `pendingUpgradeReference` stays set; later initiates converge on the same Paystack link (no second reference), which is the intended behaviour — but there is no expiry/TTL on the claim or the orphaned `pending` change, so a maintenance job/TTL is still recommended to sweep stale pending upgrades.
- **In-memory rate limiting.** The quote (IP 15/min, user 10/min) and initiate (IP 15/min, user 10/min) limits live in a per-process Map; they reset on server restart and do not scale horizontally without a shared store (e.g., Redis).
- **Node type-stripping warning.** Running `verify-stage5.mjs` prints `MODULE_TYPELESS_PACKAGE_JSON` because it imports `../src/lib/proration.ts` from a CommonJS-shaped package. Harmless; Node 24 strips the TS types. Adding `"type": "module"` to `package.json` would silence it but is intentionally avoided so as not to disturb Next.js config loading.