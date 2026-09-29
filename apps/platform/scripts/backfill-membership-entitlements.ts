/**
 * One-off backfill for the payments cutover (#88).
 *
 * Members granted LSR_MEMBER by hand (a UserMembership row set in /admin/users)
 * have no Entitlement, and Entitlement is what gates `requiresLsrMember`
 * events, drives the /account membership card, and stops a member paying dues
 * twice. This creates a matching `lsr_member` Entitlement for every LSR_MEMBER
 * membership that hasn't expired, unless the user already holds an active one.
 *
 * Dry run by default: prints the plan and writes nothing.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/backfill-membership-entitlements.ts
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/backfill-membership-entitlements.ts --apply
 *
 * Deliberately reads no .env file: pass the target on the command line
 * (production values come from Vercel, never a local env file). If DIRECT_URL
 * is set it is used instead of DATABASE_URL, as in prisma/seed.cjs, so the
 * transaction doesn't go through PgBouncer. Safe to re-run.
 */

const APPLY = process.argv.includes("--apply");

// Mirror seed.cjs: prefer the direct connection over the pooler.
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
// db.ts logs every query unless NODE_ENV is production; keep the output readable.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "open-ended");

/** Later end date wins; an open-ended row (validTo = null) beats any date. */
function endsLater(a: { validTo: Date | null }, b: { validTo: Date | null }): boolean {
  if (a.validTo === null) return b.validTo !== null;
  if (b.validTo === null) return false;
  return a.validTo > b.validTo;
}

async function main() {
  const { prisma } = await import("../src/server/db");
  const { createAuditLog } = await import("../src/server/audit/log");

  const now = new Date();
  const notExpired = { OR: [{ validTo: null }, { validTo: { gt: now } }] };

  console.log(`target   ${describeTarget(process.env.DATABASE_URL!)}`);
  console.log(`mode     ${APPLY ? "APPLY — will write" : "dry run — nothing is written"}\n`);

  const tier = await prisma.membershipTier.findUnique({ where: { key: "LSR_MEMBER" } });
  if (!tier) throw new Error("MembershipTier LSR_MEMBER not found — is this the right database?");

  const memberships = await prisma.userMembership.findMany({
    where: { tierId: tier.id, ...notExpired },
    include: { user: { select: { handle: true } } },
    orderBy: { validFrom: "asc" },
  });

  // One entitlement per user, matching the membership that runs longest.
  const byUser = new Map<string, (typeof memberships)[number]>();
  for (const m of memberships) {
    const current = byUser.get(m.userId);
    if (!current || endsLater(m, current)) byUser.set(m.userId, m);
  }

  const existing = await prisma.entitlement.findMany({
    where: { userId: { in: [...byUser.keys()] }, kind: "lsr_member", ...notExpired },
    select: { userId: true, validTo: true },
  });
  const existingByUser = new Map<string, { validTo: Date | null }>();
  for (const e of existing) {
    const current = existingByUser.get(e.userId);
    if (!current || endsLater(e, current)) existingByUser.set(e.userId, e);
  }

  const toCreate = [...byUser.values()].filter((m) => !existingByUser.has(m.userId));
  const shortfalls = [...byUser.values()].filter((m) => {
    const e = existingByUser.get(m.userId);
    return e && endsLater(m, e);
  });

  // Other tiers are reported, not backfilled: only LSR_MEMBER maps to lsr_member.
  const otherTiers = await prisma.userMembership.groupBy({
    by: ["tierId"],
    where: { tierId: { not: tier.id }, ...notExpired },
    _count: { _all: true },
  });
  const tierKeys = new Map(
    (await prisma.membershipTier.findMany({ select: { id: true, key: true } })).map((t) => [t.id, t.key])
  );

  console.log(`LSR_MEMBER memberships not expired   ${memberships.length}  (${byUser.size} users)`);
  console.log(`already hold an active lsr_member    ${byUser.size - toCreate.length}`);
  console.log(`entitlements to create               ${toCreate.length}\n`);

  for (const m of toCreate) {
    console.log(`  + ${m.user.handle.padEnd(28)} ${day(m.validFrom)} → ${day(m.validTo)}`);
  }
  if (shortfalls.length) {
    console.log(`\nreview by hand — entitlement ends before the membership (left alone):`);
    for (const m of shortfalls) {
      console.log(
        `  ! ${m.user.handle.padEnd(28)} entitlement → ${day(existingByUser.get(m.userId)!.validTo)}, membership → ${day(m.validTo)}`
      );
    }
  }
  if (otherTiers.length) {
    console.log(`\nnot backfilled (other tiers, not expired):`);
    for (const t of otherTiers) console.log(`  · ${(tierKeys.get(t.tierId) ?? t.tierId).padEnd(28)} ${t._count._all}`);
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to create ${toCreate.length} entitlement(s).`);
    await prisma.$disconnect();
    return;
  }
  if (!toCreate.length) {
    console.log(`\nNothing to write.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nWriting to ${describeTarget(process.env.DATABASE_URL!)} in 5s — Ctrl+C to abort.`);
  await new Promise((r) => setTimeout(r, 5000));

  const created = await prisma.$transaction(
    async (tx) => {
      // Re-check inside the transaction so a dues purchase since planning isn't doubled.
      const nowEntitled = new Set(
        (
          await tx.entitlement.findMany({
            where: { userId: { in: toCreate.map((m) => m.userId) }, kind: "lsr_member", ...notExpired },
            select: { userId: true },
          })
        ).map((e) => e.userId)
      );

      const ids: string[] = [];
      for (const m of toCreate) {
        if (nowEntitled.has(m.userId)) continue;
        const entitlement = await tx.entitlement.create({
          data: {
            userId: m.userId,
            kind: "lsr_member",
            scope: m.validTo ? "year" : "lifetime",
            validFrom: m.validFrom,
            validTo: m.validTo,
            meta: { source: "backfill", userMembershipId: m.id, tier: "LSR_MEMBER" },
          },
        });
        await createAuditLog(
          {
            actorUserId: null,
            actionType: "ENTITLEMENT_BACKFILLED",
            entityType: "ENTITLEMENT",
            entityId: entitlement.id,
            targetUserId: m.userId,
            summary: "Backfilled lsr_member entitlement from a manually granted LSR_MEMBER membership",
            metadata: { userMembershipId: m.id },
            after: entitlement,
          },
          tx
        );
        ids.push(entitlement.id);
      }
      return ids;
    },
    { timeout: 120_000, maxWait: 10_000 }
  );

  console.log(`Created ${created.length} entitlement(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("\nbackfill failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
