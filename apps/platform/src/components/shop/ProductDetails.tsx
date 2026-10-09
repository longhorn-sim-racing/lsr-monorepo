"use client";

import { useRef } from "react";
import { Product, ProductVariant } from "@/lib/shopify/types";
import { VariantSelector } from "./VariantSelector";
import { AddToCartButton } from "./AddToCartButton";
import { MobileStickyAddToCart } from "./MobileStickyAddToCart";
import { AnimatedPrice } from "./Price";
import { useTrackProductView } from "./RecentlyViewed";
import { SizeGuide } from "./SizeGuide";
import { WishlistButton } from "./WishlistButton";
import { cleanProductDescription, hasOnDemandBoilerplate, ON_DEMAND_TEXT } from "@/lib/product-content";
import { Lock, PackageOpen } from "lucide-react";

interface ProductDetailsProps {
  product: Product;
  selectedVariant: ProductVariant;
  options: { name: string; values: string[] }[];
}

export function ProductDetails({
  product,
  selectedVariant,
  options,
}: ProductDetailsProps) {
  const addToCartRef = useRef<HTMLDivElement>(null);

  // Track this product view
  useTrackProductView(product);
  
  const cleanedDescriptionHtml = cleanProductDescription(product.descriptionHtml);
  const showOnDemandNote = hasOnDemandBoilerplate(product.descriptionHtml);

  return (
    <>
      <div className="flex flex-col">
        {product.productType && (
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{product.productType}</p>
        )}
        <div className="mt-2 mb-5 flex items-start justify-between gap-4">
          <h1 className="break-words font-display font-black italic text-5xl md:text-6xl uppercase leading-[0.9]">
            {product.title}
          </h1>
          <WishlistButton
            item={{
              handle: product.handle,
              title: product.title,
              imageUrl: product.images[0]?.url || "",
              imageAlt: product.images[0]?.altText || product.title,
              price: product.priceRange.minVariantPrice,
            }}
            size="lg"
            className="flex-shrink-0 border border-white/15 hover:border-white/40"
          />
        </div>

        <div className="mb-8 flex items-baseline gap-4">
          <AnimatedPrice
            price={selectedVariant?.price || product.priceRange.minVariantPrice}
            className="font-display font-black italic text-4xl text-lsr-orange"
            currencyCodeClassName="ml-1 font-sans not-italic text-xs font-bold tracking-[0.2em] text-white/45"
          />
        </div>

        <div className="space-y-8 flex-1">
          <div className="space-y-4">
            <VariantSelector variants={product.variants} options={options} />
            {/* Show size guide for products with size options */}
            {options.some((opt) =>
              opt.name.toLowerCase().includes("size")
            ) && <SizeGuide descriptionHtml={product.descriptionHtml} />}
          </div>

          <div ref={addToCartRef} className="space-y-3 border-t border-white/10 pt-6">
            <AddToCartButton
              variant={selectedVariant}
              availableForSale={
                selectedVariant?.availableForSale && product.availableForSale
              }
              productTitle={product.title}
            />
            <p className="flex items-center gap-2 font-sans text-xs text-white/50">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Secure checkout through Shopify. Questions? Email{" "}
              <a href="mailto:info@longhornsimracing.org" className="font-bold text-white/70 hover:text-lsr-orange">info@longhornsimracing.org</a>
            </p>
          </div>

          <div className="prose prose-invert prose-sm max-w-none font-sans leading-relaxed prose-p:text-white/70 prose-li:text-white/70 prose-li:marker:text-lsr-orange prose-strong:text-white prose-headings:font-display prose-headings:italic prose-headings:uppercase">
            {cleanedDescriptionHtml ? (
              <div
                dangerouslySetInnerHTML={{ __html: cleanedDescriptionHtml }}
              />
            ) : (
              <p>{product.description}</p>
            )}
          </div>

          {showOnDemandNote && (
            <div className="relative flex gap-4 border border-white/10 bg-white/[0.02] p-5 lg:hidden">
               <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
               <PackageOpen className="mt-0.5 h-5 w-5 shrink-0 text-lsr-orange" aria-hidden />
               <div className="space-y-2">
                   <h2 className="font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white">Made to order</h2>
                   <p className="font-sans text-sm leading-relaxed text-white/60">
                       {ON_DEMAND_TEXT}
                   </p>
               </div>
            </div>
          )}
        </div>
      </div>

      <MobileStickyAddToCart
        variant={selectedVariant}
        price={selectedVariant?.price || product.priceRange.minVariantPrice}
        availableForSale={
          selectedVariant?.availableForSale && product.availableForSale
        }
        productTitle={product.title}
        targetRef={addToCartRef}
      />
    </>
  );
}
