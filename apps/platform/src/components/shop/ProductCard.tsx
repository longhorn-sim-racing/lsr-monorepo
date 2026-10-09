"use client";

import Link from "next/link";
import Image from "next/image";
import { Product } from "@/lib/shopify/types";
import { Price } from "./Price";
import { useCart } from "@/lib/shopify/CartContext";
import { ArrowRight, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { WishlistButton } from "./WishlistButton";

export function ProductCard({ product }: { product: Product }) {
  const { handle, title, priceRange, images, variants, availableForSale, productType } = product;
  const image = images[0];
  const { addToCart } = useCart();
  const [isAdding, setIsAdding] = useState(false);

  const isSingleVariant = variants.length === 1;
  const defaultVariant = variants[0];
  const canQuickAdd =
    isSingleVariant && defaultVariant.availableForSale && availableForSale;

  const isShopEnabled = process.env.NEXT_PUBLIC_SHOP_ENABLED === "true";
  const href = `/shop/products/${handle}`;

  const handleQuickAdd = async () => {
    if (!canQuickAdd || isAdding) return;

    setIsAdding(true);
    await addToCart(defaultVariant.id, 1, title);
    setIsAdding(false);
  };

  // The card is a group of siblings (not one big link) so the buttons aren't nested inside it
  return (
    <article className="group relative flex h-full flex-col border border-white/10 bg-white/[0.02] transition-colors hover:border-lsr-orange/60">
      <div className="absolute top-0 left-0 z-10 h-1 w-16 bg-lsr-orange transition-all duration-300 group-hover:w-full" />
      <Link href={href} tabIndex={-1} aria-hidden className="relative block aspect-square overflow-hidden bg-white/[0.04]">
        {image ? (
          <Image
            src={image.url}
            alt=""
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-sans text-[10px] font-bold uppercase tracking-widest text-white/25">
            No image
          </span>
        )}
        {!availableForSale && (
          <span className="absolute bottom-3 left-3 bg-lsr-charcoal/90 px-2.5 py-1 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/70">
            Sold out
          </span>
        )}
      </Link>

      <div className="absolute top-3 right-3 z-10">
        <WishlistButton
          item={{
            handle,
            title,
            imageUrl: image?.url || "",
            imageAlt: image?.altText || title,
            price: priceRange.minVariantPrice,
          }}
          size="sm"
          className="bg-lsr-charcoal/70 backdrop-blur-sm hover:bg-lsr-charcoal"
        />
      </div>

      <div className="flex flex-1 flex-col p-5">
        {productType && (
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.25em] text-white/45">{productType}</p>
        )}
        <h3 className="mt-1 font-display font-black italic text-2xl uppercase leading-tight text-white">
          <Link href={href} className="transition-colors hover:text-lsr-orange focus-visible:text-lsr-orange">
            {title}
          </Link>
        </h3>
        <div className="mt-auto flex items-center justify-between gap-3 pt-5">
          <Price
            price={priceRange.minVariantPrice}
            className="font-display font-black italic text-2xl text-lsr-orange"
            currencyCodeClassName="hidden"
          />
          {isShopEnabled &&
            (canQuickAdd ? (
              <button
                type="button"
                onClick={handleQuickAdd}
                disabled={isAdding}
                aria-label={`Add ${title} to cart`}
                className="inline-flex h-10 items-center gap-2 bg-lsr-orange px-4 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal disabled:opacity-60"
              >
                {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                {isAdding ? "Adding" : "Add"}
              </button>
            ) : availableForSale ? (
              <Link
                href={href}
                tabIndex={-1}
                aria-hidden
                className="inline-flex h-10 items-center gap-2 border border-white/20 px-4 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
              >
                Choose options
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : null)}
        </div>
      </div>
    </article>
  );
}
