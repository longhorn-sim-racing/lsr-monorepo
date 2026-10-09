import { getProducts } from "@/lib/shopify/catalog";
import { FilterableProductGrid } from "@/components/shop/FilterableProductGrid";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowRight, ShoppingCart } from "lucide-react";
import { siInstagram } from "simple-icons/icons";
import { BrandIcon } from "@/components/brand-icon";
import { INSTAGRAM_PROFILE_URL } from "@/lib/instagram";

const SHOP_ENABLED = process.env.NEXT_PUBLIC_SHOP_ENABLED === "true";

export const metadata: Metadata = {
  title: "Shop",
  description: "Official Longhorn Sim Racing Merchandise and Team Kit.",
  openGraph: {
    title: "Shop - Longhorn Sim Racing",
    description: "Official Longhorn Sim Racing Merchandise and Team Kit.",
    type: "website",
  },
  alternates: {
    canonical: "/shop",
  },
};

/** The shop's header: the kit photo on the right, the pitch on the left (photo on top on phones) */
function ShopHero({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden border-b border-white/10 bg-lsr-charcoal">
      <div className="relative h-64 sm:h-80 lg:absolute lg:inset-y-0 lg:right-0 lg:h-auto lg:w-[62%]">
        <CloudinaryImage
          publicId="gallery/merch-shoot/img-1300"
          alt="Three LSR members in the team kit, backs to the camera, under a brick archway"
          fill
          preload
          sizes="(min-width: 1024px) 62vw, 100vw"
          className="object-cover object-[center_35%]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-transparent to-transparent lg:bg-gradient-to-r lg:from-lsr-charcoal lg:via-lsr-charcoal/30 lg:to-transparent" />
      </div>
      <div className="absolute inset-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
      <div className="relative mx-auto max-w-6xl px-6 pb-12 pt-2 md:px-8 lg:flex lg:min-h-[480px] lg:items-center lg:py-20">
        <div className="max-w-md">{children}</div>
      </div>
    </div>
  );
}

const secondaryButton =
  "inline-flex h-12 items-center justify-center gap-2 border border-white/25 px-6 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal";

/** For when there's nothing to sell: the shop is switched off, or the catalog can't be reached */
function ShopOffline({ title, text }: { title: React.ReactNode; text: string }) {
  return (
    <ShopHero>
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Official merch</p>
      <h1 className="mt-3 font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9]">{title}</h1>
      <p className="mt-5 font-sans text-base md:text-lg leading-relaxed text-white/75">{text}</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <a href={INSTAGRAM_PROFILE_URL} target="_blank" rel="noopener noreferrer" className={secondaryButton}>
          <span aria-hidden>
            <BrandIcon icon={siInstagram} label="" className="h-4 w-4" />
          </span>
          Follow for the next drop
        </a>
      </div>
    </ShopHero>
  );
}

export default async function ShopPage() {
  if (!SHOP_ENABLED) {
    return (
      <ShopOffline
        title={
          <>
            Merch drop <span className="text-lsr-orange">closed</span>
          </>
        }
        text="The LSR shop is currently closed. Stay tuned for our next seasonal drop."
      />
    );
  }

  let allProducts: Awaited<ReturnType<typeof getProducts>> = [];
  try {
    allProducts = await getProducts();
  } catch (error) {
    // A Shopify outage (or a frozen store) must not fail the build or the page.
    console.error("[Shop] Failed to load catalog:", error);
  }

  if (!allProducts.length) {
    return (
      <ShopOffline
        title={
          <>
            Coming <span className="text-lsr-orange">soon</span>
          </>
        }
        text="There's nothing in the shop right now. Follow us on Instagram to hear when the next drop lands."
      />
    );
  }

  return (
    <div className="pb-16 md:pb-24">
      <ShopHero>
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Official merch</p>
        <h1 className="mt-3 font-display font-black italic text-6xl md:text-8xl uppercase leading-[0.85]">
          LSR <span className="text-lsr-orange">Shop</span>
        </h1>
        <p className="mt-5 font-sans text-base md:text-lg font-bold uppercase tracking-[0.15em] text-white/80">
          Official team kit and streetwear.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a
            href="#products"
            className="inline-flex h-12 items-center justify-center gap-2 bg-lsr-orange px-6 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
          >
            Shop the range
            <ArrowDown className="h-4 w-4" aria-hidden />
          </a>
          <Link href="/shop/cart" className={secondaryButton}>
            <ShoppingCart className="h-4 w-4" aria-hidden />
            Your cart
          </Link>
        </div>
      </ShopHero>

      <section id="products" aria-labelledby="products-title" className="scroll-mt-24 px-6 pt-12 md:px-8 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
                {allProducts.length} {allProducts.length === 1 ? "item" : "items"}
              </p>
              <h2 id="products-title" className="mt-2 font-display font-black italic text-4xl md:text-5xl uppercase leading-none">
                The <span className="text-lsr-orange">range</span>
              </h2>
            </div>
            <Link
              href="/shop/wishlist"
              className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange"
            >
              Your wishlist <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
          </div>
          <FilterableProductGrid products={allProducts} />
        </div>
      </section>
    </div>
  );
}
