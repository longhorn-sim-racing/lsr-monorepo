"use client"

import { RouteError } from "@/components/route-error"

export default function AccountError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      error={error}
      reset={reset}
      kicker="Your account"
      title={
        <>
          Couldn&apos;t load <span className="text-lsr-orange">your account</span>
        </>
      }
      back={{ href: "/", label: "Back to the homepage" }}
    >
      <p>Something broke on our side while loading your account. Nothing was changed; try again in a moment.</p>
    </RouteError>
  )
}
