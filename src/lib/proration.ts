export const MS_PER_DAY = 86_400_000;

export interface UpgradeProrationInput {
  oldPeriodAmountMinor: number;
  newPeriodAmountMinor: number;
  currency: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  now: Date;
}

export interface UpgradeProrationResult {
  currentPeriodDays: number;
  daysRemaining: number;
  oldPeriodAmountMinor: number;
  newPeriodAmountMinor: number;
  creditMinor: number;
  chargeMinor: number;
  currency: string;
}

/**
 * Whole number of UTC calendar days spanned by a billing period.
 *
 * Periods are created by calculateSubscriptionPeriod which preserves the
 * time-of-day across month/year boundaries, so the span is always a whole
 * number of days. Math.round neutralises any sub-millisecond drift.
 */
export function getCalendarPeriodDays(start: Date, end: Date): number {
  const days = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
  if (days <= 0) {
    throw new Error("Billing period must span at least one full day.");
  }
  return days;
}

/**
 * Whole number of days remaining in the period at instant `now`.
 *
 * Convention (used consistently everywhere):
 *   daysRemaining = ceil((periodEnd - now) / 1 day), clamped to [0, totalDays].
 *
 * The current partial UTC day is credited in full. This reproduces the
 * assessment example exactly: a 30-day period upgraded on day 12 leaves
 * 18 full days remaining. At the exact period end the result is 0, and a
 * user upgrading at the exact period start receives the full period.
 */
export function getDaysRemaining(
  periodStart: Date,
  periodEnd: Date,
  now: Date,
  totalDays: number
): number {
  const rawRemaining = Math.ceil((periodEnd.getTime() - now.getTime()) / MS_PER_DAY);
  return Math.max(0, Math.min(rawRemaining, totalDays));
}

/**
 * Server-side proration for the Monthly → Yearly upgrade.
 *
 * All money is integer minor units. No floating-point money.
 *
 * formula:
 *   creditMinor  = round(oldPeriodAmountMinor * daysRemaining / currentPeriodDays)
 *   chargeMinor  = newPeriodAmountMinor - creditMinor
 *
 * Rounding rule: standard half-up rounding applied to the credit fraction.
 * For the documented example (₦5,000 monthly, 30-day period, 18 days
 * remaining): credit = round(500000 * 18 / 30) = 300000 kobo = ₦3,000 and
 * charge = 5000000 - 300000 = 4700000 kobo = ₦47,000.
 */
export function calculateUpgradeProration(
  input: UpgradeProrationInput
): UpgradeProrationResult {
  const { oldPeriodAmountMinor, newPeriodAmountMinor, currency } = input;
  const now = input.now ?? new Date();

  const currentPeriodDays = getCalendarPeriodDays(
    input.currentPeriodStart,
    input.currentPeriodEnd
  );

  const daysRemaining = getDaysRemaining(
    input.currentPeriodStart,
    input.currentPeriodEnd,
    now,
    currentPeriodDays
  );

  const creditMinor = Math.round(
    (oldPeriodAmountMinor * daysRemaining) / currentPeriodDays
  );
  const chargeMinor = newPeriodAmountMinor - creditMinor;

  if (chargeMinor <= 0) {
    throw new Error(
      `Upgrade charge must be positive (computed ${chargeMinor} minor units).`
    );
  }

  return {
    currentPeriodDays,
    daysRemaining,
    oldPeriodAmountMinor,
    newPeriodAmountMinor,
    creditMinor,
    chargeMinor,
    currency,
  };
}