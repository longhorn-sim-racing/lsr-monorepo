"use client";

import Link from "next/link";
import Image from "next/image";
import { Money } from "@/lib/shopify/types";
import { Price } from "./Price";

/** The empty cart and empty wishlist: a card with an icon, a line of copy and the way back to the shop */
export function ShopEmpty({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action: { href: string; label: string };
}) {
  return (
    <div className="relative flex flex-col items-center border border-white/10 bg-white/[0.02] px-6 py-14 text-center md:py-20">
      <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
      <span className="flex h-16 w-16 items-center justify-center bg-lsr-orange/15 text-lsr-orange" aria-hidden>
        {icon}
      </span>
      <h2 className="mt-6 font-display font-black italic text-3xl md:text-4xl uppercase leading-none">{title}</h2>
      <p className="mt-3 max-w-sm font-sans text-sm leading-relaxed text-white/60">{text}</p>
      <Link
        href={action.href}
        className="mt-8 inline-flex h-12 items-center justify-center bg-lsr-orange px-8 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
      >
        {action.label}
      </Link>
    </div>
  );
}

/** A saved or recently viewed product. `action` sits over the image, beside the link rather than inside it. */
export function ShopTile({
  handle,
  title,
  imageUrl,
  price,
  action,
  sizes = "(min-width: 1024px) 25vw, 50vw",
}: {
  handle: string;
  title: string;
  imageUrl: string;
  price: Money;
  action?: React.ReactNode;
  sizes?: string;
}) {
  const href = `/shop/products/${handle}`;
  return (
    <div className="group relative flex h-full flex-col border border-white/10 bg-white/[0.02] transition-colors hover:border-lsr-orange/60">
      <Link href={href} tabIndex={-1} aria-hidden className="relative block aspect-square overflow-hidden bg-white/[0.04]">
        {imageUrl && (
          <Image src={imageUrl} alt="" fill sizes={sizes} className="object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
        )}
      </Link>
      {action && <div className="absolute top-3 right-3">{action}</div>}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-display font-black italic text-lg uppercase leading-tight text-white">
          <Link href={href} className="transition-colors hover:text-lsr-orange">
            {title}
          </Link>
        </h3>
        <Price price={price} className="mt-auto pt-2 font-display font-black italic text-lg text-lsr-orange" currencyCodeClassName="hidden" />
      </div>
    </div>
  );
}
