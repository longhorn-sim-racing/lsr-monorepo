"use client";

import { ProductVariant } from "@/lib/shopify/types";
import { useCart } from "@/lib/shopify/CartContext";
import { Loader2, Trash2, Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export function AddToCartButton({
  variant,
  availableForSale,
  productTitle,
}: {
  variant: ProductVariant;
  availableForSale: boolean;
  productTitle?: string;
}) {
  const { cart, addToCart, updateQuantity, removeItem, isUpdating } = useCart();

  const handleAddToCart = async () => {
    const variantTitle = variant.title !== "Default Title" ? variant.title : undefined;
    const title = [productTitle, variantTitle].filter(Boolean).join(" - ");
    await addToCart(variant.id, 1, title || undefined);
  };

  const cartLine = cart?.lines.find((line) => line.merchandise.id === variant.id);
  const quantity = cartLine?.quantity || 0;

  const isEnabled = process.env.NEXT_PUBLIC_SHOP_ENABLED === "true";

  if (!isEnabled) {
       return (
        <Button
          disabled
          className="w-full bg-white/5 border border-white/10 text-white/40 font-black uppercase tracking-[0.2em] h-14 rounded-none cursor-not-allowed"
        >
          Store Closed
        </Button>
      );
  }

  if (!availableForSale) {
    return (
      <Button
        disabled
        className="w-full bg-white/5 border border-white/10 text-white/40 font-black uppercase tracking-[0.2em] h-14 rounded-none cursor-not-allowed"
      >
        Sold Out
      </Button>
    );
  }

  if (cartLine) {
    return (
      <div className="flex items-center gap-2 h-14 w-full">
        <div className="flex items-center flex-1 h-full border border-white/20 bg-lsr-charcoal">
          <button
            onClick={() => updateQuantity(cartLine.id, quantity - 1)}
            disabled={isUpdating || quantity <= 1}
            className="h-full px-4 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors border-r border-white/10"
            aria-label="Decrease quantity"
          >
            <Minus className="h-3 w-3" />
          </button>
          
          <div className="flex-1 flex items-center justify-center font-mono font-bold text-base text-white">
            {isUpdating ? <Loader2 className="h-4 w-4 animate-spin text-lsr-orange" /> : quantity}
          </div>
          
          <button
            onClick={() => updateQuantity(cartLine.id, quantity + 1)}
            disabled={isUpdating}
            className="h-full px-4 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors border-l border-white/10"
            aria-label="Increase quantity"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        <Button
          asChild
          variant="outline"
          className="h-full rounded-none border-white/20 bg-transparent text-white font-bold uppercase tracking-widest text-[10px] px-6 hover:bg-white hover:text-lsr-charcoal transition-all whitespace-nowrap"
        >
          <Link href="/shop/cart">View Cart</Link>
        </Button>

        <Button
          onClick={() => removeItem(cartLine.id)}
          disabled={isUpdating}
          variant="outline"
          className="h-full w-14 rounded-none border-white/20 bg-transparent text-white/40 hover:text-red-500 hover:border-red-500/50 hover:bg-red-500/10 transition-all p-0 flex items-center justify-center shrink-0"
          aria-label="Remove from cart"
        >
          <Trash2 className="h-5 w-5" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={handleAddToCart}
      disabled={isUpdating}
      className="w-full bg-white text-lsr-charcoal font-black uppercase tracking-[0.2em] h-14 rounded-none hover:bg-lsr-orange hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
    >
      {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
      {isUpdating ? "Adding..." : "Add to Cart"}
    </Button>
  );
}
