import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function RetiredPage() {
  return (
    <div className="flex min-h-[70svh] items-center bg-lsr-charcoal px-6 py-16 text-white md:px-8">
      <div className="relative mx-auto w-full max-w-xl border border-white/10 bg-white/[0.02] p-8 md:p-12">
        <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Account retired</p>
        <h1 className="mt-3 font-display font-black italic text-4xl md:text-5xl uppercase leading-[0.95]">
          Thanks for <span className="text-lsr-orange">racing</span>
        </h1>
        <p className="mt-5 font-sans text-base leading-relaxed text-white/70">
          Your account is <span className="font-bold text-white">retired</span>. Your driver page and results stay up, but you&apos;re signed out and can&apos;t use member features.
        </p>
        <p className="mt-3 font-sans text-sm leading-relaxed text-white/55">
          Want back on the grid? Email{" "}
          <a href="mailto:info@longhornsimracing.org" className="font-bold text-lsr-orange hover:text-white">
            info@longhornsimracing.org
          </a>{" "}
          and an officer can reactivate you.
        </p>
        <Button asChild className="mt-8 h-12 rounded-none border border-white/20 bg-transparent px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
          <Link href="/">Back to the homepage</Link>
        </Button>
      </div>
    </div>
  )
}
