import Link from "next/link"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProductCheckoutButton } from "@/components/product-checkout-button"
import { formatCents } from "@/lib/money"

export type EntryState =
  | { kind: "entered" }
  | { kind: "unavailable" }
  | { kind: "signin"; priceCents: number }
  | { kind: "membership" }
  | {
      kind: "open"
      /** The entry form is filled in; only payment is left */
      applied: boolean
      priceCents: number
      returningCents: number | null
      isReturning: boolean
    }

const primary =
  "h-auto min-h-12 rounded-none bg-lsr-orange px-7 py-3 font-sans text-xs font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"

/** The Lone Star Cup entry button, in whatever state the visitor's entry is in. */
export function EntryCta({ state, align = "start" }: { state: EntryState; align?: "start" | "center" }) {
  const items = align === "center" ? "items-center text-center" : "items-start"

  if (state.kind === "entered") {
    return (
      <div className={`flex flex-col gap-1 ${items}`}>
        <p className="inline-flex items-center gap-2 font-sans text-sm font-bold uppercase tracking-widest text-lsr-orange">
          <Check className="h-4 w-4" /> You&apos;re entered
        </p>
        <p className="font-sans text-xs text-white/55">The comp team will give you the LSC role on Discord.</p>
      </div>
    )
  }

  if (state.kind === "unavailable") {
    return <p className="font-sans text-sm text-white/60">Entry is closed right now.</p>
  }

  if (state.kind === "signin") {
    return (
      <div className={`flex flex-col gap-2 ${items}`}>
        <Button asChild className={primary}>
          <Link href="/auth/signin?next=/lone-star-cup/enter">Sign in to enter — {formatCents(state.priceCents)}</Link>
        </Button>
        <p className="font-sans text-[11px] text-white/45">Sign in or make an account, then fill out the entry form.</p>
      </div>
    )
  }

  if (state.kind === "membership") {
    return (
      <Button asChild className={primary}>
        <Link href="/account">Membership required</Link>
      </Button>
    )
  }

  return (
    <div className={`flex flex-col gap-2 ${items}`}>
      {state.applied ? (
        <>
          <ProductCheckoutButton product="LEAGUE_FEE" league="lone-star-cup" label="Pay entry fee" priceCents={state.priceCents} />
          <Link
            href="/lone-star-cup/enter"
            className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/45 transition-colors hover:text-lsr-orange"
          >
            Edit entry form
          </Link>
        </>
      ) : (
        <Button asChild className={primary}>
          <Link href="/lone-star-cup/enter">Enter the Lone Star Cup — {formatCents(state.priceCents)}</Link>
        </Button>
      )}
      {state.returningCents !== null && (
        <p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/45">
          {state.isReturning ? "Returning driver rate applied" : `Returning drivers pay ${formatCents(state.returningCents)}`}
        </p>
      )}
      <p className="font-sans text-[11px] text-white/40">
        Payment issues or refunds:{" "}
        <a href="mailto:info@longhornsimracing.org" className="text-white/60 transition-colors hover:text-lsr-orange">
          info@longhornsimracing.org
        </a>
      </p>
    </div>
  )
}
