import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { requireOfficer } from "@/server/auth/guards";
import { getProductById } from "@/server/queries/products";
import { getSeasonSlugOptions } from "@/server/queries/seasons";
import { ProductEditForm, type SeasonOption } from "@/components/admin/product-edit-form";
import { readProductMetadataFields } from "@/schemas/product.schema";
import { formatCents } from "@/lib/money";
import { PRODUCT_TYPE_LABELS } from "@/lib/payments";

export const dynamic = "force-dynamic";

export default async function AdminProductEditPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    await requireOfficer();

    const [product, seasons] = await Promise.all([getProductById(id), getSeasonSlugOptions()]);
    if (!product) {
        notFound();
    }

    const fields = readProductMetadataFields(product.metadata);

    // Saved slugs that aren't Seasons (the seed uses series slugs) stay listed so saving keeps them.
    const seasonSlugs = new Set(seasons.map((s) => s.slug));
    const seasonOptions: SeasonOption[] = [
        ...seasons.map((s) => ({ slug: s.slug, name: s.name })),
        ...fields.returningSeasonSlugs
            .filter((slug) => !seasonSlugs.has(slug))
            .map((slug) => ({ slug, name: null })),
    ];

    return (
        <div className="max-w-3xl mx-auto space-y-8">
            <Link
                href="/admin/products"
                className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-lsr-orange transition-colors"
            >
                <ArrowLeft className="w-3 h-3" />
                Back to Products
            </Link>

            <div className="border border-white/10 bg-lsr-charcoal p-6 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-lsr-orange">
                    {PRODUCT_TYPE_LABELS[product.type]}
                    {product.league && <span className="text-white/40"> · {product.league.name}</span>}
                </p>
                <h1 className="font-display font-black italic text-2xl text-white uppercase tracking-tight">
                    {product.name}
                </h1>
                <p className="text-xs text-white/40 font-mono">
                    {formatCents(product.amountCents)} {product.currency}
                    <span className="ml-3 text-white/25">{product.active ? "Active" : "Inactive"}</span>
                </p>
            </div>

            {product.active && (
                <div className="flex items-start gap-2 bg-amber-900/20 border border-amber-900/50 p-4 text-xs text-amber-200">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>
                        <strong>This product is live.</strong> Changes apply to new checkouts immediately.
                    </span>
                </div>
            )}

            <ProductEditForm
                product={{
                    id: product.id,
                    type: product.type,
                    name: product.name,
                    amountCents: product.amountCents,
                    active: product.active,
                    ...fields,
                }}
                seasonOptions={seasonOptions}
            />
        </div>
    );
}
