import Link from "next/link";
import { Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/money";
import { PRODUCT_TYPE_LABELS } from "@/lib/payments";
import { cn } from "@/lib/utils";
import { readProductMetadataFields } from "@/schemas/product.schema";
import type { AdminProduct } from "@/server/queries/products";

export function ProductsConsole({ products }: { products: AdminProduct[] }) {
  return (
    <div className="flex flex-col border border-white/10 bg-black/40 overflow-hidden font-mono text-sm">
      {/* Toolbar */}
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4">
        <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 border border-white/10">
          <Package size={14} className="text-lsr-orange" />
          <span className="font-bold text-white/80 tracking-wider uppercase">Products</span>
        </div>
        <p className="text-[10px] uppercase tracking-wider text-white/40">
          Prices charged at checkout. Click a row to edit.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-white/5 border-b border-white/10 text-left text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
              <th className="px-4 py-2 font-bold">Type</th>
              <th className="px-4 py-2 font-bold">Name</th>
              <th className="px-4 py-2 font-bold">League</th>
              <th className="px-4 py-2 font-bold text-right">Price</th>
              <th className="px-4 py-2 font-bold text-right">Returning</th>
              <th className="px-4 py-2 font-bold">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-white/40">
                  No products. Products are created by the seed script.
                </td>
              </tr>
            ) : (
              products.map((product) => {
                const href = `/admin/products/${product.id}`;
                const { returningAmountCents, returningSeasonSlugs } = readProductMetadataFields(product.metadata);
                const isLeague = product.type === "LEAGUE_FEE";

                return (
                  <tr key={product.id} className="group border-b border-white/5 last:border-b-0 hover:bg-white/5">
                    <td className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-white/40 whitespace-nowrap">
                      {PRODUCT_TYPE_LABELS[product.type]}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={href} className="font-bold text-white group-hover:text-lsr-orange transition-colors">
                        {product.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-white/60">{product.league?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-bold text-white whitespace-nowrap">
                      {formatCents(product.amountCents)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {isLeague && returningAmountCents !== null ? (
                        <>
                          <div className="font-bold text-white">{formatCents(returningAmountCents)}</div>
                          <div className="text-[10px] text-white/40">
                            {returningSeasonSlugs.length} season{returningSeasonSlugs.length === 1 ? "" : "s"}
                          </div>
                        </>
                      ) : (
                        <span className="text-white/20">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-none uppercase tracking-wider text-[10px]",
                          product.active
                            ? "bg-green-500/10 text-green-500 border-green-500/30"
                            : "bg-white/10 text-white/50 border-white/20"
                        )}
                      >
                        {product.active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={href} className="text-white/10 group-hover:text-white/40 transition-colors" aria-label={`Edit ${product.name}`}>
                        →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
