"use client";

import { useCart } from "@/lib/shopify/CartContext";
import { Price } from "./Price";
import Image from "next/image";
import Link from "next/link";
import { Loader2, Trash2, ArrowRight, Lock, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCartState } from "./EmptyCartState";

export function CartView() {
  const { cart, isLoading, isUpdating, updateQuantity, removeItem } = useCart();

  if (isLoading) {
    return (
      <div role="status" className="flex h-[40vh] w-full items-center justify-center text-white/40">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        <span className="sr-only">Loading your cart</span>
      </div>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return <EmptyCartState />;
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-10">
      <ul className="space-y-3" aria-label="Items in your cart">
        {cart.lines.map((line) => {
          const product = line.merchandise.product;
          const href = `/shop/products/${product.handle}`;
          const variantTitle = line.merchandise.title !== "Default Title" ? line.merchandise.title : null;
          return (
            <li key={line.id} className="group relative flex gap-4 border border-white/10 bg-white/[0.02] p-4 md:gap-6 md:p-5">
              <Link
                href={href}
                tabIndex={-1}
                aria-hidden
                className="relative block h-24 w-24 shrink-0 overflow-hidden border border-white/10 bg-white/[0.04] md:h-28 md:w-28"
              >
                {product.featuredImage && (
                  <Image
                    src={product.featuredImage.url}
                    alt=""
                    fill
                    sizes="112px"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                )}
              </Link>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link
                      href={href}
                      className="block font-display font-black italic text-xl md:text-2xl uppercase leading-tight text-white transition-colors hover:text-lsr-orange"
                    >
                      {product.title}
                    </Link>
                    {variantTitle && (
                      <p className="mt-1 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">{variantTitle}</p>
                    )}
                  </div>
                  <Price
                    price={line.cost.totalAmount}
                    className="shrink-0 font-display font-black italic text-xl text-white"
                    currencyCodeClassName="hidden"
                  />
                </div>

                <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
                  <div className="flex h-10 items-center border border-white/15">
                    <button
                      type="button"
                      onClick={() => updateQuantity(line.id, line.quantity - 1)}
                      disabled={isUpdating || line.quantity <= 1}
                      aria-label={`One less ${product.title}`}
                      className="flex h-full w-10 items-center justify-center text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <Minus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <span className="w-10 text-center font-display font-black italic text-lg text-white" aria-label={`Quantity ${line.quantity}`}>
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(line.id, line.quantity + 1)}
                      disabled={isUpdating}
                      aria-label={`One more ${product.title}`}
                      className="flex h-full w-10 items-center justify-center text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeItem(line.id)}
                    disabled={isUpdating}
                    aria-label={`Remove ${product.title} from your cart`}
                    className="inline-flex h-10 items-center gap-2 px-1 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/50 transition-colors hover:text-red-300 disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    Remove
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <aside aria-labelledby="cart-summary" className="lg:sticky lg:top-24 lg:self-start">
        <div className="relative border border-white/10 bg-white/[0.02] p-6 md:p-7">
          <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
            {cart.totalQuantity} {cart.totalQuantity === 1 ? "item" : "items"}
          </p>
          <h2 id="cart-summary" className="mt-2 font-display font-black italic text-3xl uppercase leading-none">
            Summary
          </h2>

          <dl className="mt-6 space-y-3 font-sans text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-white/60">Subtotal</dt>
              <dd>
                <Price price={cart.cost.subtotalAmount} currencyCodeClassName="hidden" />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-white/60">Tax (Est.)</dt>
              <dd>
                <Price price={cart.cost.totalTaxAmount} currencyCodeClassName="hidden" />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t border-white/10 pt-4">
              <dt className="font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white">Total</dt>
              <dd>
                <Price
                  price={cart.cost.totalAmount}
                  className="font-display font-black italic text-3xl text-lsr-orange"
                  currencyCodeClassName="ml-1 font-sans not-italic text-xs font-bold tracking-[0.2em] text-white/45"
                />
              </dd>
            </div>
          </dl>
          <p className="mt-2 font-sans text-xs text-white/45">Shipping calculated at checkout.</p>

          <Button
            asChild
            className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-none bg-lsr-orange font-sans text-xs font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
          >
            <a href={cart.checkoutUrl}>
              Checkout <ArrowRight className="h-4 w-4" aria-hidden />
            </a>
          </Button>
          <p className="mt-3 flex items-center gap-2 font-sans text-xs text-white/50">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Secure checkout through Shopify.
          </p>
        </div>
        <Link
          href="/shop"
          className="group mt-4 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-lsr-orange"
        >
          Keep shopping <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" aria-hidden />
        </Link>
      </aside>
    </div>
  );
}
