/* eslint-disable @typescript-eslint/no-require-imports */

// Use direct connection for seed to avoid PgBouncer prepared-statement issues
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  // ---- Roles ----
  // Permission roles
  await prisma.role.upsert({
    where: { key: "officer" },
    update: { description: "Officer - Admin console access" },
    create: { key: "officer", description: "Officer - Admin console access" },
  });
  await prisma.role.upsert({
    where: { key: "admin" },
    update: { description: "Admin - Full system access" },
    create: { key: "admin", description: "Admin - Full system access" },
  });

  // Participation roles (display badges)
  await prisma.role.upsert({
    where: { key: "lsc_driver" },
    update: { description: "Lone Star Cup Driver" },
    create: { key: "lsc_driver", description: "Lone Star Cup Driver" },
  });
  await prisma.role.upsert({
    where: { key: "collegiate_driver" },
    update: { description: "Collegiate Series Driver" },
    create: { key: "collegiate_driver", description: "Collegiate Series Driver" },
  });

  // Clean up old roles that are no longer used
  await prisma.role.deleteMany({
    where: { key: { in: ["member", "competition"] } },
  });

  // ---- Membership tiers ----
  await prisma.membershipTier.upsert({
    where: { key: "GENERAL" },
    update: { label: "General Member" },
    create: { key: "GENERAL", label: "General Member" },
  });
  await prisma.membershipTier.upsert({
    where: { key: "LSR_MEMBER" },
    update: { label: "LSR Member" },
    create: { key: "LSR_MEMBER", label: "LSR Member" },
  });
  await prisma.membershipTier.upsert({
    where: { key: "ALUMNI" },
    update: { label: "Alumni" },
    create: { key: "ALUMNI", label: "Alumni" },
  });
  await prisma.membershipTier.upsert({
    where: { key: "PARTNER" },
    update: { label: "Partner" },
    create: { key: "PARTNER", label: "Partner" },
  });

  // ---- League: Lone Star Cup ----
  const loneStarCup = await prisma.league.upsert({
    where: { slug: "lone-star-cup" },
    update: {},
    create: {
      name: "Lone Star Cup",
      slug: "lone-star-cup",
      descriptionMd: "Flagship in-house league for LSR.",
      visibility: "public",
    },
  });

  // ---- Products ----
  // Annual dues ($20): can't use upsert on (type, leagueId) with leagueId = null.
  const existingAnnual = await prisma.product.findFirst({
    where: { type: "ANNUAL_DUES", leagueId: null },
    select: { id: true },
  });
  if (existingAnnual) {
    await prisma.product.update({
      where: { id: existingAnnual.id },
      data: { name: "Annual LSR Dues", amountCents: 2000, currency: "USD", active: true },
    });
  } else {
    await prisma.product.create({
      data: {
        type: "ANNUAL_DUES",
        name: "Annual LSR Dues",
        amountCents: 2000,
        currency: "USD",
        active: true,
        leagueId: null,
      },
    });
  }

  // League fee: $10 new, $5 for drivers in a past season's standings (Competition, 9/25).
  // Safe to upsert because leagueId is non-null.
  const lscPricing = {
    returningAmountCents: 500,
    returningSeasonSlugs: ["lone-star-cup-s1", "lone-star-cup-s2"],
  };
  await prisma.product.upsert({
    where: { type_leagueId: { type: "LEAGUE_FEE", leagueId: loneStarCup.id } },
    update: { name: "Lone Star Cup Entry Fee", amountCents: 1000, currency: "USD", active: true, metadata: lscPricing },
    create: {
      type: "LEAGUE_FEE",
      name: "Lone Star Cup Entry Fee",
      amountCents: 1000,
      currency: "USD",
      active: true,
      metadata: lscPricing,
      league: { connect: { id: loneStarCup.id } },
    },
  });

  // ---- Event Series: Lone Star Cup seasons ----
  await prisma.eventSeries.upsert({
    where: { slug: "lone-star-cup-s1" },
    update: {},
    create: { title: "Lone Star Cup Season 1", slug: "lone-star-cup-s1", visibility: "public" },
  });
  await prisma.eventSeries.upsert({
    where: { slug: "lone-star-cup-s2" },
    update: {},
    create: { title: "Lone Star Cup Season 2", slug: "lone-star-cup-s2", visibility: "public" },
  });

  // ---- Optional initial Season ----
  await prisma.season.upsert({
    where: { slug: "lone-star-cup-2025" },
    update: {},
    create: {
      leagueId: loneStarCup.id,
      name: "Lone Star Cup 2025",
      slug: "lone-star-cup-2025",
      year: 2025,
      pointsRule: {
        places: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
        dnf: 0,
        dsq: 0,
      },
      visibility: "public",
    },
  });

  console.log("✅ Seed complete.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
