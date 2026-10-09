"use client";

import { useEffect, useState } from "react";
import { Heart, Loader2, Trash2 } from "lucide-react";
import { WishlistItem, getWishlist, removeFromWishlist } from "@/lib/shopify/wishlist";
import { toast } from "sonner";
import { ShopEmpty, ShopTile } from "./ShopTiles";

export function WishlistView() {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setItems(getWishlist());
    setIsLoading(false);

    const handleUpdate = () => {
      setItems(getWishlist());
    };

    window.addEventListener("wishlist-updated", handleUpdate);
    return () => window.removeEventListener("wishlist-updated", handleUpdate);
  }, []);

  const handleRemove = (handle: string, title: string) => {
    removeFromWishlist(handle);
    toast.success("Removed from wishlist", { description: title });
  };

  if (isLoading) {
    return (
      <div role="status" className="flex items-center justify-center py-20 text-white/40">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        <span className="sr-only">Loading your wishlist</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <ShopEmpty
        icon={<Heart className="h-7 w-7" />}
        title="Your wishlist is empty"
        text="Save items you love by clicking the heart icon."
        action={{ href: "/shop", label: "Browse the shop" }}
      />
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
      {items.map((item) => (
        <li key={item.handle}>
          <ShopTile
            handle={item.handle}
            title={item.title}
            imageUrl={item.imageUrl}
            price={item.price}
            action={
              <button
                type="button"
                onClick={() => handleRemove(item.handle, item.title)}
                className="flex h-9 w-9 items-center justify-center bg-lsr-charcoal/70 text-white/70 backdrop-blur-sm transition-colors hover:bg-lsr-charcoal hover:text-red-300"
                aria-label={`Remove ${item.title} from your wishlist`}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            }
          />
        </li>
      ))}
    </ul>
  );
}
