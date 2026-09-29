import type { Prisma, Product } from "@prisma/client";
import { prisma } from "@/server/db";
import { readProductMetadataFields, type ProductUpdate } from "@/schemas/product.schema";

export class ProductUpdateError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "ProductUpdateError";
  }
}

type ProductSnapshot = Pick<Product, "name" | "amountCents" | "active" | "metadata">;

const snapshot = ({ name, amountCents, active, metadata }: Product): ProductSnapshot => ({
  name,
  amountCents,
  active,
  metadata,
});

/**
 * Applies an admin edit to a seeded product. The returning-price and membership
 * keys are written for LEAGUE_FEE products only; every other metadata key is
 * carried over untouched.
 */
export async function applyProductUpdate(id: string, input: ProductUpdate) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new ProductUpdateError("Product not found.");

  const data: Prisma.ProductUpdateInput = {
    name: input.name,
    amountCents: input.amountCents,
    active: input.active,
  };

  if (product.type === "LEAGUE_FEE") {
    const current = product.metadata;
    const metadata: Record<string, unknown> =
      current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};

    await assertKnownSeasonSlugs(
      input.returningSeasonSlugs,
      readProductMetadataFields(current).returningSeasonSlugs
    );

    if (input.returningAmountCents === null) delete metadata.returningAmountCents;
    else metadata.returningAmountCents = input.returningAmountCents;

    if (input.returningSeasonSlugs.length) metadata.returningSeasonSlugs = input.returningSeasonSlugs;
    else delete metadata.returningSeasonSlugs;

    // Requiring dues while dues aren't on sale would leave drivers with no way to enter.
    if (input.requiresMembership) {
      const dues = await prisma.product.findFirst({ where: { type: "ANNUAL_DUES", active: true }, select: { id: true } });
      if (!dues) {
        throw new ProductUpdateError(
          "Dues aren't on sale, so drivers couldn't meet this requirement. Turn the dues product on first.",
          "requiresMembership"
        );
      }
    }
    metadata.requiresMembership = input.requiresMembership;
    data.metadata = metadata as Prisma.InputJsonObject;
  }

  const updated = await prisma.product.update({ where: { id }, data });
  return { before: snapshot(product), after: snapshot(updated) };
}

/** Slugs must name a Season, except ones already saved (seeded series slugs) so they survive a save. */
async function assertKnownSeasonSlugs(slugs: string[], savedSlugs: string[]) {
  if (!slugs.length) return;
  const seasons = await prisma.season.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true },
  });
  const known = new Set([...seasons.map((s) => s.slug), ...savedSlugs]);
  const unknown = slugs.filter((s) => !known.has(s));
  if (unknown.length) {
    throw new ProductUpdateError(`Unknown season: ${unknown.join(", ")}`, "returningSeasonSlugs");
  }
}
