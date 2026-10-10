"use client"

import { RouteError } from "@/components/route-error"

export default function ShopError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      error={error}
      reset={reset}
      kicker="Shop"
      title={
        <>
          The shop is <span className="text-lsr-orange">in the pits</span>
        </>
      }
      back={{ href: "/", label: "Back to the homepage" }}
    >
      <p>We couldn&apos;t reach the store just now. Your cart is saved on this device, so try again in a minute.</p>
    </RouteError>
  )
}
