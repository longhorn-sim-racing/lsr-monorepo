import { getStripe } from "@/lib/stripe";
import { prisma } from "@/server/db";

/**
 * Expires a user's unpaid Stripe Checkout sessions for a product (or any product of a
 * league), so a forgotten tab can't be paid on top of a newer checkout or a manual
 * entry. Nothing is charged or refunded; Stripe then sends checkout.session.expired and
 * the webhook marks those payments failed. Best effort: a session that was just paid or
 * already expired is left alone.
 */
export async function expireOpenCheckouts(
  userId: string,
  target: { productId: string } | { leagueId: string }
): Promise<void> {
  const open = await prisma.payment.findMany({
    where: {
      userId,
      status: "pending",
      providerRef: { startsWith: "cs_" },
      ...("productId" in target ? { productId: target.productId } : { product: { leagueId: target.leagueId } }),
    },
    select: { providerRef: true },
  });
  for (const { providerRef } of open) {
    await getStripe()
      .checkout.sessions.expire(providerRef!)
      .catch((err) => console.warn(`[Checkout] Couldn't expire ${providerRef}:`, err instanceof Error ? err.message : err));
  }
}
