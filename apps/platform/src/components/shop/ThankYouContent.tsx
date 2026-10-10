"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { clearStoredCartId } from "@/lib/shopify/cartStorage";
import { useCart } from "@/lib/shopify/CartContext";
import { StatusScreen, statusPrimary, statusSecondary } from "@/components/status-screen";

export function ThankYouContent() {
  const { refreshCart } = useCart();

  // Clear cart on mount
  useEffect(() => {
    clearStoredCartId();
    refreshCart();
  }, [refreshCart]);

  return (
    <StatusScreen
      kicker="Order placed"
      title={
        <>
          Thank <span className="text-lsr-orange">you!</span>
        </>
      }
      photo="gallery/merch-shoot/img-1403"
      actions={
        <>
          <Link href="/shop" className={`${statusPrimary} gap-2`}>
            Continue shopping
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link href="/" className={statusSecondary}>
            Back to home
          </Link>
        </>
      }
    >
      <p>Your order has been placed successfully.</p>
      <p className="mt-3 text-base text-white/60">
        Check your email for order confirmation and tracking details. We&apos;ll get your gear to you as soon as possible.
      </p>
    </StatusScreen>
  );
}
