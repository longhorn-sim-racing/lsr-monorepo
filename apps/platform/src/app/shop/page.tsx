import { getProducts } from "@/lib/shopify/catalog";
import Image from "next/image";
import { FilterableProductGrid } from "@/components/shop/FilterableProductGrid";
import { Metadata } from "next";

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

export default async function ShopPage() {
  if (!SHOP_ENABLED) {
    return (
      <div className="relative min-h-screen flex items-center justify-center overflow-hidden -mt-20">
        {/* Background Image with Overlay */}
        <div className="absolute inset-0 z-0">
          <Image
            src="/images/gal_12.jpg"
            alt="LSR Racing Background"
            fill
            className="object-cover opacity-50 grayscale"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent via-70% to-lsr-charcoal" />
        </div>

        {/* Centered Content */}
        <div className="relative z-10 container mx-auto px-6 text-center">
          <h1 className="font-display font-black italic text-6xl md:text-9xl uppercase tracking-normal mb-6 leading-none">
            Merch Drop <br className="md:hidden" /><span className="text-lsr-orange">Closed</span>
          </h1>
          <p className="font-sans text-lg md:text-xl text-white/60 mb-12 max-w-2xl mx-auto uppercase tracking-[0.2em] font-bold">
            The LSR shop is currently closed. <br />Stay tuned for our next seasonal drop.
          </p>
          <div className="inline-block border-2 border-white/10 bg-white/5 backdrop-blur-md px-10 py-5 uppercase tracking-[0.4em] font-black text-xs md:text-sm text-white/40">
            Next Drop: <span className="text-white">TBA</span>
          </div>
        </div>
      </div>
    );
  }

  let allProducts: Awaited<ReturnType<typeof getProducts>> = [];
  try {
    allProducts = await getProducts();
  } catch (error) {
    // A Shopify outage (or a frozen store) must not fail the build or the page.
    console.error("[Shop] Failed to load catalog:", error);
  }

  // If no products, show empty state
  if (!allProducts.length) {
    return (
      <div className="container mx-auto px-6 py-24 text-center">
         <h1 className="font-display font-black italic text-4xl uppercase tracking-normal mb-4">
          Coming Soon
        </h1>
        <p className="text-white/60">No products found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-10 md:space-y-14 pb-10 md:pb-14">
        {/* Hero-ish header */}
        <div className="relative min-h-[50vh] flex items-center justify-center overflow-hidden -mt-20 mb-10">
            {/* Background Image with Overlay */}
            <div className="absolute inset-0 z-0">
              <Image
                src="/images/gal_12.jpg"
                alt="LSR Racing Background"
                fill
                className="object-cover opacity-50 grayscale"
                priority
              />
              <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent via-70% to-lsr-charcoal" />
            </div>

            <div className="relative z-10 max-w-6xl mx-auto px-6 text-center mt-20">
                 <h1 className="font-display font-black italic text-5xl md:text-8xl uppercase tracking-normal mb-6 leading-none">
                  LSR <span className="text-lsr-orange">Shop</span>
                </h1>
                <p className="font-sans text-lg md:text-xl text-white/60 max-w-2xl mx-auto uppercase tracking-[0.2em] font-bold">
                    Official team kit and streetwear.
                </p>
            </div>
        </div>

        <div className="px-6 md:px-8">
            <div className="mx-auto max-w-6xl">
                <FilterableProductGrid products={allProducts} />
            </div>
        </div>
    </div>
  );
}
