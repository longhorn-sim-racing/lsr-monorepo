import { z } from "zod";
import { dollarsToCents, formatCents } from "@/lib/money";

/** Stripe's smallest USD charge; product-pricing.ts ignores returning prices below it. */
export const MIN_PRODUCT_CENTS = 50;
const MAX_PRODUCT_CENTS = 99_999_999;

const dollarAmount = z.string().trim().transform((value, ctx) => {
  if (!value) return null;
  const cents = dollarsToCents(value);
  if (cents === null || cents > MAX_PRODUCT_CENTS) {
    ctx.addIssue({ code: "custom", message: "Enter a dollar amount like 10.00" });
    return z.NEVER;
  }
  return cents;
});

// `amount` and `returningAmount` arrive as dollar strings and leave as integer cents.
export const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
    amount: dollarAmount,
    active: z.boolean(),
    returningAmount: dollarAmount,
    returningSeasonSlugs: z.array(z.string().trim().min(1)).max(50),
    requiresMembership: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.amount === null) {
      ctx.addIssue({ code: "custom", path: ["amount"], message: "Price is required" });
    } else if (p.amount < MIN_PRODUCT_CENTS) {
      ctx.addIssue({ code: "custom", path: ["amount"], message: `Price must be at least ${formatCents(MIN_PRODUCT_CENTS)}` });
    }
    if (p.returningAmount === null) return;
    if (p.returningAmount < MIN_PRODUCT_CENTS) {
      ctx.addIssue({ code: "custom", path: ["returningAmount"], message: `Returning price must be at least ${formatCents(MIN_PRODUCT_CENTS)}` });
    } else if (p.amount !== null && p.returningAmount >= p.amount) {
      ctx.addIssue({ code: "custom", path: ["returningAmount"], message: "Returning price must be less than the standard price" });
    }
    if (p.returningSeasonSlugs.length === 0) {
      ctx.addIssue({ code: "custom", path: ["returningSeasonSlugs"], message: "Pick at least one season that counts as returning" });
    }
  })
  .transform(({ amount, returningAmount, returningSeasonSlugs, ...rest }) => ({
    ...rest,
    amountCents: amount as number,
    returningAmountCents: returningAmount,
    returningSeasonSlugs: [...new Set(returningSeasonSlugs)],
  }));

export type ProductUpdateInput = z.input<typeof productUpdateSchema>;
export type ProductUpdate = z.output<typeof productUpdateSchema>;

export type ProductMetadataFields = {
  returningAmountCents: number | null;
  returningSeasonSlugs: string[];
  requiresMembership: boolean;
};

/** The metadata keys the admin form edits, read leniently from whatever is stored. */
export function readProductMetadataFields(metadata: unknown): ProductMetadataFields {
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
  return {
    returningAmountCents: typeof meta.returningAmountCents === "number" ? meta.returningAmountCents : null,
    returningSeasonSlugs: Array.isArray(meta.returningSeasonSlugs)
      ? meta.returningSeasonSlugs.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [],
    requiresMembership: meta.requiresMembership === true,
  };
}
