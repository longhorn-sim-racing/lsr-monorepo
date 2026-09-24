// src/server/repos/membership.repo.ts
import { prisma } from '@/server/db';

export async function getActiveEntitlements(userId: string) {
  const now = new Date();
  return prisma.entitlement.findMany({
    where: {
      userId,
      validFrom: { lte: now },
      OR: [{ validTo: { gte: now } }, { validTo: null }],
    },
  });
}

/**
 * This is a stub function to be implemented when payments are integrated.
 * It will grant an entitlement to a user based on a successful payment.
 */
export async function grantEntitlementFromPayment(paymentId: string) {
  // 1. Look up the payment and the associated product
  // 2. Determine the entitlement to grant based on the product
  // 3. Create the entitlement with the correct validity period
  // 4. Log the audit trail
  console.log('grantEntitlementFromPayment stub called for paymentId:', paymentId);
  return Promise.resolve();
}
