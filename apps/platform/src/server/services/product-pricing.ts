import { prisma } from "@/server/db";
import type { Product } from "@prisma/client";

/**
 * A league product can offer returning drivers a lower price through its
 * `metadata` (no schema change):
 *
 *   { "returningAmountCents": 500,
 *     "returningSeasonSlugs": ["lone-star-cup-s1", "lone-star-cup-s2"] }
 *
 * A driver is "returning" when they appear in the standings of any listed
 * season. Adding a new season to the list is a data change, not a deploy.
 */
type ReturningPricing = {
  returningAmountCents: number;
  returningSeasonSlugs: string[];
};

export type ProductPrice = {
  amountCents: number;
  tier: "standard" | "returning";
  /** The product's returning-driver rate, whichever tier applied; null when it has none. */
  returningAmountCents: number | null;
};

type PricedProduct = Pick<Product, "type" | "amountCents" | "metadata">;

/** Stripe's smallest USD charge. */
const STRIPE_MIN_CENTS = 50;

function readReturningPricing(product: PricedProduct): ReturningPricing | null {
  if (product.type !== "LEAGUE_FEE") return null;
  const meta = product.metadata as Record<string, unknown> | null;
  const cents = meta?.returningAmountCents;
  const slugs = meta?.returningSeasonSlugs;

  // A malformed or pointless config charges the standard price rather than guessing.
  if (
    typeof cents !== "number" ||
    !Number.isInteger(cents) ||
    cents < STRIPE_MIN_CENTS ||
    cents >= product.amountCents ||
    !Array.isArray(slugs)
  ) {
    return null;
  }
  const returningSeasonSlugs = slugs.filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (!returningSeasonSlugs.length) return null;

  return { returningAmountCents: cents, returningSeasonSlugs };
}

/**
 * A league product can require paid LSR dues before entry with
 * `{ "requiresMembership": true }` in its metadata. Off unless set.
 */
export function productRequiresMembership(product: Pick<Product, "type" | "metadata">): boolean {
  if (product.type !== "LEAGUE_FEE") return false;
  const meta = product.metadata as Record<string, unknown> | null;
  return meta?.requiresMembership === true;
}

/**
 * True when the user has a standings entry in any of the given seasons, matched
 * by the season's slug or its series' slug (the same lookup standings.repo uses).
 */
export async function isReturningDriver(
  userId: string,
  seasonSlugs: string[]
): Promise<boolean> {
  const entry = await prisma.entry.findFirst({
    where: {
      userId,
      OR: [
        { season: { slug: { in: seasonSlugs } } },
        { season: { series: { slug: { in: seasonSlugs } } } },
      ],
    },
    select: { id: true },
  });
  return entry !== null;
}

/**
 * The price this user pays for a product. Signed-out visitors (userId null)
 * see the standard price; checkout always re-resolves it server-side.
 */
export async function priceForUser(
  product: PricedProduct,
  userId: string | null
): Promise<ProductPrice> {
  const returning = readReturningPricing(product);
  if (!returning) {
    return { amountCents: product.amountCents, tier: "standard", returningAmountCents: null };
  }
  if (userId && (await isReturningDriver(userId, returning.returningSeasonSlugs))) {
    return {
      amountCents: returning.returningAmountCents,
      tier: "returning",
      returningAmountCents: returning.returningAmountCents,
    };
  }
  return {
    amountCents: product.amountCents,
    tier: "standard",
    returningAmountCents: returning.returningAmountCents,
  };
}
