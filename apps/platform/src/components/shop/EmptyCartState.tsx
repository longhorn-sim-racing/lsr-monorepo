"use client";

import { useEffect, useState } from "react";
import { ShoppingCart } from "lucide-react";
import { RecentProduct, getRecentlyViewed } from "@/lib/shopify/recentlyViewed";
import { ShopEmpty, ShopTile } from "./ShopTiles";

export function EmptyCartState() {
  const [recentItems, setRecentItems] = useState<RecentProduct[]>([]);

  useEffect(() => {
    const items = getRecentlyViewed();
    setRecentItems(items.slice(0, 4));
  }, []);

  return (
    <div className="space-y-14">
      <ShopEmpty
        icon={<ShoppingCart className="h-7 w-7" />}
        title="Your cart is empty"
        text="Looks like you haven't added any gear yet."
        action={{ href: "/shop", label: "Start shopping" }}
      />

      {/* Recently Viewed section */}
      {recentItems.length > 0 && (
        <section aria-labelledby="recent-title">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Pick up where you left off</p>
          <h2 id="recent-title" className="mt-2 mb-6 font-display font-black italic text-3xl uppercase leading-none">
            Recently <span className="text-lsr-orange">viewed</span>
          </h2>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
            {recentItems.map((item) => (
              <li key={item.handle}>
                <ShopTile handle={item.handle} title={item.title} imageUrl={item.imageUrl} price={item.price} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
