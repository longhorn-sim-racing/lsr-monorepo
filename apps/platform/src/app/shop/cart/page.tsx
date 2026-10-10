import { CartView } from "@/components/shop/CartView";
import { Breadcrumbs } from "@/components/shop/Breadcrumbs";

export default function CartPage() {
  return (
    <div className="min-h-[60vh] px-6 md:px-8 pb-16 md:pb-24 pt-8 md:pt-12">
        <div className="max-w-6xl mx-auto">
            <Breadcrumbs 
              items={[
                { label: "Shop", href: "/shop" },
                { label: "Your cart" }
              ]} 
            />
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Almost there</p>
            <h1 className="mt-2 mb-8 font-display font-black italic text-5xl md:text-6xl uppercase leading-[0.9]">
                Your <span className="text-lsr-orange">cart</span>
            </h1>
            <CartView />
        </div>
    </div>
  );
}
