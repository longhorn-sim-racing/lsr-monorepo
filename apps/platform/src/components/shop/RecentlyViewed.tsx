"use client";

import { useEffect, useState } from "react";
import {
  RecentProduct,
  getRecentlyViewed,
  addRecentlyViewed,
} from "@/lib/shopify/recentlyViewed";
import { ShopTile } from "./ShopTiles";
import { Product } from "@/lib/shopify/types";

interface RecentlyViewedProps {
  currentHandle: string;
}

export function RecentlyViewed({ currentHandle }: RecentlyViewedProps) {
  const [items, setItems] = useState<RecentProduct[]>([]);

  useEffect(() => {
    // Get recently viewed, excluding current product
    const viewed = getRecentlyViewed().filter(
      (item) => item.handle !== currentHandle
    );
    setItems(viewed);
  }, [currentHandle]);

  if (items.length === 0) return null;

  return (
    <section aria-labelledby="recently-viewed" className="mt-16 border-t border-white/10 pt-12 md:mt-20 md:pt-16">
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Pick up where you left off</p>
      <h2 id="recently-viewed" className="mt-2 mb-6 font-display font-black italic text-3xl md:text-4xl uppercase leading-none">
        Recently <span className="text-lsr-orange">viewed</span>
      </h2>

      <ul className="-mx-6 flex gap-3 overflow-x-auto px-6 pb-2 md:mx-0 md:grid md:grid-cols-4 md:gap-4 md:overflow-visible md:px-0">
        {items.slice(0, 8).map((item) => (
          <li key={item.handle} className="w-44 shrink-0 md:w-auto">
            <ShopTile handle={item.handle} title={item.title} imageUrl={item.imageUrl} price={item.price} sizes="(min-width: 768px) 25vw, 176px" />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Hook to track product views
export function useTrackProductView(product: Product) {
  useEffect(() => {
    if (!product) return;

    const recentProduct: RecentProduct = {
      handle: product.handle,
      title: product.title,
      imageUrl: product.images[0]?.url || "",
      imageAlt: product.images[0]?.altText || product.title,
      price: product.priceRange.minVariantPrice,
    };

    addRecentlyViewed(recentProduct);
  }, [product]);
}
