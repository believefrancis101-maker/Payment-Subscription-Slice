This is a payment and subscription management slice built with [Next.js 16](https://nextjs.org), [Prisma](https://www.prisma.io), SQLite, and [Paystack](https://paystack.com). It implements the full subscription lifecycle: plan selection, Paystack-hosted checkout, server-side payment verification, subscription fulfilment, prorated upgrades, scheduled downgrades, and cancellation at period end.

## Documentation & Architecture

For full architectural decisions, API routes, data models, and verification evidence, see:
- [System Documentation (`DOCUMENTATION.md`)](./DOCUMENTATION.md)

## Getting Started

1. Copy the environment template and fill in your Paystack test keys:
```bash
cp .env.example .env
```

2. Push the SQLite database schema:
```bash
pnpm run db:push
```

3. Seed the subscription plans (Free, Monthly, Yearly):
```bash
pnpm run db:seed
```

4. Run the development server:
```bash
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser. Sign in and navigate to `/plans` to begin the subscription flow.
