import { getStripe } from "@/lib/stripe";
import { prisma } from "@/server/db";

/**
 * Expires a user's unpaid Stripe Checkout sessions for a product (or any product of a
 * league), so a forgotten tab can't be paid on top of a newer checkout or a manual
 * entry. Nothing is charged or refunded; Stripe then sends checkout.session.expired and
 * the webhook marks those payments failed. Best effort: never throws, and a session
 * that was just paid is left for the webhook.
 */
export async function expireOpenCheckouts(
  userId: string,
  target: { productId: string } | { leagueId: string }
): Promise<void> {
  try {
    const open = await prisma.payment.findMany({
      where: {
        userId,
        status: "pending",
        providerRef: { startsWith: "cs_" },
        ...("productId" in target ? { productId: target.productId } : { product: { leagueId: target.leagueId } }),
      },
      select: { id: true, providerRef: true },
    });
    if (!open.length) return;

    const stripe = getStripe();
    const results = await Promise.allSettled(
      open.map(async ({ id, providerRef }) => {
        const session = await stripe.checkout.sessions.retrieve(providerRef!);
        if (session.status === "open") {
          await stripe.checkout.sessions.expire(session.id);
        } else if (session.status === "expired") {
          // We missed its webhook; settle the row here so it isn't retried every checkout.
          await prisma.payment.updateMany({ where: { id, status: "pending" }, data: { status: "failed" } });
        }
        // "complete" means paid or still settling; the webhook takes it from there.
      })
    );
    for (const r of results) {
      if (r.status === "rejected") console.warn("[Checkout] Couldn't expire an open checkout:", r.reason);
    }
  } catch (error) {
    console.warn("[Checkout] Couldn't expire open checkouts:", error instanceof Error ? error.message : error);
  }
}
