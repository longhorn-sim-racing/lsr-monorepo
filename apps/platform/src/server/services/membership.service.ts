import { prisma } from "@/server/db";
import { Prisma } from "@prisma/client";
import { createAuditLog } from "@/server/audit/log";

export type MembershipSyncResult =
  | { action: "none"; reason: "paid" | "in-sync" | "no-membership" | "no-tier" }
  | { action: "created" | "updated" | "ended"; entitlementIds: string[] };

/** Later end date wins; an open-ended row (validTo = null) beats any date. */
function endsLater(a: { validTo: Date | null }, b: { validTo: Date | null }): boolean {
  if (a.validTo === null) return b.validTo !== null;
  if (b.validTo === null) return false;
  return a.validTo > b.validTo;
}

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/**
 * Keeps a manually granted LSR membership and its `lsr_member` Entitlement in
 * step. Officers grant, extend and revoke membership by editing the
 * UserMembership row in /admin/users, but event eligibility, the /account card
 * and dues checkout read Entitlement. Called after every admin edit.
 *
 * Derives the result from the user's current state rather than the form:
 * - an active *paid* lsr_member entitlement (sourcePaymentId set) is left alone;
 *   refunds revoke it (payment.service revokeProduct), and mirroring the
 *   payment-created membership here would leave a free copy behind after a refund
 * - otherwise, an active LSR_MEMBER membership gets exactly one manual
 *   entitlement (sourcePaymentId null) with the same window: created, or
 *   updated to match; any extra manual ones are ended
 * - no active LSR_MEMBER membership ends every active manual entitlement
 *
 * Writes an ENTITLEMENT_SYNCED audit row whenever it changes something.
 */
export async function syncManualMembershipEntitlement(
  userId: string,
  actorUserId: string | null
): Promise<MembershipSyncResult> {
  const now = new Date();
  const notExpired = { OR: [{ validTo: null }, { validTo: { gt: now } }] };

  return prisma.$transaction(async (tx) => {
    const tier = await tx.membershipTier.findUnique({ where: { key: "LSR_MEMBER" } });
    if (!tier) return { action: "none", reason: "no-tier" } as const;

    const memberships = await tx.userMembership.findMany({
      where: { userId, tierId: tier.id, ...notExpired },
    });
    const membership = memberships.reduce<(typeof memberships)[number] | null>(
      (best, m) => (!best || endsLater(m, best) ? m : best),
      null
    );

    const entitlements = await tx.entitlement.findMany({
      where: { userId, kind: "lsr_member", ...notExpired },
    });
    if (entitlements.some((e) => e.sourcePaymentId)) {
      return { action: "none", reason: "paid" } as const;
    }
    const manual = [...entitlements].sort((a, b) => (endsLater(a, b) ? -1 : endsLater(b, a) ? 1 : 0));

    let result: MembershipSyncResult;

    if (!membership) {
      if (!manual.length) return { action: "none", reason: "no-membership" } as const;
      for (const e of manual) {
        await tx.entitlement.update({ where: { id: e.id }, data: { validTo: now } });
      }
      result = { action: "ended", entitlementIds: manual.map((e) => e.id) };
    } else {
      const [keep, ...extra] = manual;
      for (const e of extra) {
        await tx.entitlement.update({ where: { id: e.id }, data: { validTo: now } });
      }

      if (!keep) {
        const created = await tx.entitlement.create({
          data: {
            userId,
            kind: "lsr_member",
            scope: membership.validTo ? "year" : "lifetime",
            validFrom: membership.validFrom,
            validTo: membership.validTo,
            meta: { source: "admin", userMembershipId: membership.id },
          },
        });
        result = { action: "created", entitlementIds: [created.id, ...extra.map((e) => e.id)] };
      } else if (
        !sameInstant(keep.validFrom, membership.validFrom) ||
        !sameInstant(keep.validTo, membership.validTo) ||
        extra.length
      ) {
        const previousMeta = (keep.meta ?? {}) as Prisma.JsonObject;
        await tx.entitlement.update({
          where: { id: keep.id },
          data: {
            validFrom: membership.validFrom,
            validTo: membership.validTo,
            scope: membership.validTo ? "year" : "lifetime",
            meta: { ...previousMeta, source: previousMeta.source ?? "admin", userMembershipId: membership.id },
          },
        });
        result = { action: "updated", entitlementIds: [keep.id, ...extra.map((e) => e.id)] };
      } else {
        return { action: "none", reason: "in-sync" } as const;
      }
    }

    await createAuditLog(
      {
        actorUserId,
        actionType: "ENTITLEMENT_SYNCED",
        entityType: "ENTITLEMENT",
        entityId: result.entitlementIds[0],
        targetUserId: userId,
        summary: `lsr_member entitlement ${result.action} to match the user's LSR_MEMBER membership`,
        metadata: {
          action: result.action,
          entitlementIds: result.entitlementIds,
          userMembershipId: membership?.id ?? null,
          membershipValidTo: membership?.validTo ?? null,
        },
      },
      tx
    );
    return result;
  });
}
