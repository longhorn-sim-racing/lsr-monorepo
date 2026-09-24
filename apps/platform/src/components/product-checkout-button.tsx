"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ProductCheckoutButtonProps = {
  product: "ANNUAL_DUES" | "LEAGUE_FEE";
  league?: string;
  label: string;
  priceCents: number;
};

export function ProductCheckoutButton({
  product,
  league,
  label,
  priceCents,
}: ProductCheckoutButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, league }),
      });
      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Could not start checkout");
        return;
      }

      if (typeof data.url !== "string") {
        toast.error("Could not start checkout");
        return;
      }

      window.location.href = data.url;
    } catch (error) {
      console.error("Failed to start product checkout", error);
      toast.error("An error occurred starting checkout");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      onClick={handleCheckout}
      disabled={loading}
      className="h-12 rounded-none bg-lsr-orange px-6 font-sans text-xs font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"
    >
      {loading ? "Starting checkout..." : `${label} — $${(priceCents / 100).toFixed(2)}`}
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
