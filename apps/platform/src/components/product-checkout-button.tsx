"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";

type CheckoutProduct = "ANNUAL_DUES" | "LEAGUE_FEE";

type ProductCheckoutButtonProps = {
  product: CheckoutProduct;
  league?: string;
  label: string;
  priceCents: number;
};

/**
 * Opens Stripe Checkout for a product. Resolves false (after a toast) when checkout
 * couldn't start; on success the browser is already navigating away.
 */
export async function startProductCheckout(product: CheckoutProduct, league?: string): Promise<boolean> {
  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product, league }),
    });
    const data = await response.json();

    if (!response.ok || typeof data.url !== "string") {
      toast.error(data.message || "Could not start checkout");
      return false;
    }

    window.location.href = data.url;
    return true;
  } catch (error) {
    console.error("Failed to start product checkout", error);
    toast.error("An error occurred starting checkout");
    return false;
  }
}

export function ProductCheckoutButton({
  product,
  league,
  label,
  priceCents,
}: ProductCheckoutButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async () => {
    setLoading(true);
    // Stay disabled through the redirect so a second click can't open a second session.
    if (!(await startProductCheckout(product, league))) setLoading(false);
  };

  return (
    <Button
      type="button"
      onClick={handleCheckout}
      disabled={loading}
      className="h-auto min-h-12 max-w-full whitespace-normal rounded-none bg-lsr-orange px-6 py-3 text-center font-sans text-xs font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"
    >
      {loading ? "Starting checkout..." : `${label} — ${formatCents(priceCents)}`}
    </Button>
  );
}

export function ProductPaymentToast() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const payment = searchParams.get("payment");
    if (payment === "success") {
      toast.success("Payment completed. Your account will update shortly.");
    } else if (payment === "cancelled") {
      toast("Checkout cancelled. You have not been charged.");
    }
  }, [searchParams]);

  return null;
}
