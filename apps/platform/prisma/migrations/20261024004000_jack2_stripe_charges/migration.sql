-- Jack 2.0 T4 (sources-a): Stripe charges, synced daily with their fee, net and payout (design §12.3),
-- so a payout's payments and a Payment's Stripe side can be shown without calling Stripe live.
-- Additive: one new table, with no card, billing or customer details in it. jack_readonly reads it
-- through the role's default privileges (nothing in it is personal or secret). Old code never reads it.

-- CreateTable
CREATE TABLE "public"."StripeCharge" (
    "id" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "amountRefundedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "purpose" TEXT,
    "feeCents" INTEGER,
    "netCents" INTEGER,
    "payoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StripeCharge_paymentIntentId_idx" ON "public"."StripeCharge"("paymentIntentId");

-- CreateIndex
CREATE INDEX "StripeCharge_payoutId_idx" ON "public"."StripeCharge"("payoutId");

-- CreateIndex
CREATE INDEX "StripeCharge_createdAt_idx" ON "public"."StripeCharge"("createdAt");
