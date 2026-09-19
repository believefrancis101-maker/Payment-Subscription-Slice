import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const SEED_PLANS = [
  {
    name: "Free",
    interval: "free",
    amountMinor: 0,
    currency: "NGN",
    active: true,
  },
  {
    name: "Monthly",
    interval: "monthly",
    amountMinor: 500000,
    currency: "NGN",
    active: true,
  },
  {
    name: "Yearly",
    interval: "yearly",
    amountMinor: 5000000,
    currency: "NGN",
    active: true,
  },
] as const;

async function main() {
  console.log("Seeding subscription plans...");

  for (const plan of SEED_PLANS) {
    const upsertedPlan = await prisma.plan.upsert({
      where: {
        name_interval: {
          name: plan.name,
          interval: plan.interval,
        },
      },
      update: {
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        active: plan.active,
      },
      create: {
        name: plan.name,
        interval: plan.interval,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        active: plan.active,
      },
    });
    console.log(
      `Upserted plan: ${upsertedPlan.name} (${upsertedPlan.interval}) - ${upsertedPlan.amountMinor} ${upsertedPlan.currency}`
    );
  }

  console.log("Seeding completed successfully.");
}

main()
  .catch((e) => {
    console.error("Error during plan seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
