"use client"

import { RouteError } from "@/components/route-error"

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      error={error}
      reset={reset}
      code="500"
      kicker="Something went wrong"
      title={
        <>
          Red <span className="text-lsr-orange">flag</span>
        </>
      }
      back={{ href: "/", label: "Back to the homepage" }}
    >
      <p>Something broke on our side while loading this page. Try again in a moment.</p>
    </RouteError>
  )
}
