"use client"

import { RouteError } from "@/components/route-error"

export default function AuthError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      error={error}
      reset={reset}
      kicker="Sign in"
      title={
        <>
          Sign-in hit <span className="text-lsr-orange">a snag</span>
        </>
      }
      back={{ href: "/", label: "Back to the homepage" }}
    >
      <p>Something broke on our side on this page. Try again in a moment; your account details weren&apos;t changed.</p>
    </RouteError>
  )
}
