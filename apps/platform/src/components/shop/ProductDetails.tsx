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
import { PackageOpen } from "lucide-react";

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
        <div className="flex items-start justify-between gap-4 mb-4">
          <h1 className="font-display font-black italic text-4xl md:text-5xl uppercase tracking-normal leading-none">
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
            className="flex-shrink-0"
          />
        </div>

        <div className="mb-8 flex items-baseline gap-4">
          <AnimatedPrice
            price={selectedVariant?.price || product.priceRange.minVariantPrice}
            className="text-2xl md:text-3xl font-sans font-bold text-lsr-orange"
            currencyCodeClassName="text-sm text-white/40 ml-1"
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

          <div ref={addToCartRef} className="pt-4 border-t border-white/10">
            <AddToCartButton
              variant={selectedVariant}
              availableForSale={
                selectedVariant?.availableForSale && product.availableForSale
              }
              productTitle={product.title}
            />
          </div>

          <div className="prose prose-invert prose-sm text-white/60 font-sans leading-relaxed">
            {cleanedDescriptionHtml ? (
              <div
                dangerouslySetInnerHTML={{ __html: cleanedDescriptionHtml }}
              />
            ) : (
              <p>{product.description}</p>
            )}
          </div>

          {showOnDemandNote && (
            <div className="lg:hidden mt-8 pt-8 border-t border-white/10 flex gap-4">
               <PackageOpen className="w-5 h-5 text-lsr-orange shrink-0 mt-0.5" />
               <div className="space-y-2">
                   <h4 className="font-display font-black uppercase text-xs tracking-widest text-white/80">Made to Order</h4>
                   <p className="text-[11px] text-white/50 font-sans leading-relaxed">
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
