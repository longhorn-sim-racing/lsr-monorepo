"use client";

import { useEffect, useState } from "react";
import { ProductVariant, Money } from "@/lib/shopify/types";
import { useCart } from "@/lib/shopify/CartContext";
import { Price } from "./Price";
import { Loader2, Minus, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import Link from "next/link";

interface MobileStickyAddToCartProps {
  variant: ProductVariant;
  price: Money;
  availableForSale: boolean;
  productTitle: string;
  targetRef: React.RefObject<HTMLElement | null>;
}

export function MobileStickyAddToCart({
  variant,
  price,
  availableForSale,
  productTitle,
  targetRef,
}: MobileStickyAddToCartProps) {
  const [isVisible, setIsVisible] = useState(false);
  const { cart, addToCart, updateQuantity, removeItem, isUpdating } = useCart();
  const isEnabled = process.env.NEXT_PUBLIC_SHOP_ENABLED === "true";

  const cartLine = cart?.lines.find((line) => line.merchandise.id === variant.id);
  const quantity = cartLine?.quantity || 0;

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show sticky bar when target is NOT in view
        setIsVisible(!entry.isIntersecting);
      },
      {
        threshold: 0,
        rootMargin: "-80px 0px 0px 0px", // Account for header height
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [targetRef]);

  const handleAddToCart = async () => {
    const variantTitle = variant.title !== "Default Title" ? variant.title : undefined;
    const title = [productTitle, variantTitle].filter(Boolean).join(" - ");
    await addToCart(variant.id, 1, title || undefined);
  };

  if (!isEnabled) return null;

  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 z-40 bg-lsr-charcoal/95 backdrop-blur-md border-t border-white/10 p-4 md:hidden",
        "transform transition-transform duration-300 ease-out",
        isVisible ? "translate-y-0" : "translate-y-full"
      )}
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
        <Price
          price={price}
          className="font-sans font-bold text-lg text-lsr-orange"
          currencyCodeClassName="text-sm text-white/40 ml-1"
        />

        {cartLine ? (
             <div className="flex-1 max-w-xs flex items-center gap-1.5 h-12">
                <div className="flex items-center flex-1 h-full border border-white/20 bg-lsr-charcoal">
                  <button
                    onClick={() => updateQuantity(cartLine.id, quantity - 1)}
                    disabled={isUpdating || quantity <= 1}
                    className="h-full px-2 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors border-r border-white/10"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  
                  <div className="flex-1 flex items-center justify-center font-mono font-bold text-sm text-white">
                    {isUpdating ? <Loader2 className="h-3 w-3 animate-spin text-lsr-orange" /> : quantity}
                  </div>
                  
                  <button
                    onClick={() => updateQuantity(cartLine.id, quantity + 1)}
                    disabled={isUpdating}
                    className="h-full px-2 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors border-l border-white/10"
                    aria-label="Increase quantity"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                <Button
                  asChild
                  variant="outline"
                  className="h-full rounded-none border-white/20 bg-white text-lsr-charcoal hover:bg-lsr-orange hover:text-white font-bold uppercase tracking-widest text-[9px] px-3 transition-all flex items-center justify-center shrink-0"
                >
                  <Link href="/shop/cart">Cart</Link>
                </Button>

                <Button
                  onClick={() => removeItem(cartLine.id)}
                  disabled={isUpdating}
                  variant="outline"
                  className="h-full w-10 rounded-none border-white/20 bg-transparent text-white/40 hover:text-red-500 hover:border-red-500/50 hover:bg-red-500/10 transition-all p-0 flex items-center justify-center shrink-0"
                  aria-label="Remove from cart"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
            </div>
        ) : (
            <button
              onClick={handleAddToCart}
              disabled={!availableForSale || isUpdating}
              className={cn(
                "flex-1 max-w-xs h-12 font-black uppercase tracking-[0.15em] text-sm transition-all flex items-center justify-center gap-2",
                availableForSale
                  ? "bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal"
                  : "bg-white/10 text-white/40 cursor-not-allowed"
              )}
            >
              {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
              {!availableForSale ? "Sold out" : isUpdating ? "Adding…" : "Add to cart"}
            </button>
        )}
      </div>
    </div>
  );
}
