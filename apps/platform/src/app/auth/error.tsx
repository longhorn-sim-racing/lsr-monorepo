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
      back={{ href: "/auth/forgot-password", label: "Reset my password" }}
    >
      <p>Something broke on our side while signing you in. Try again, or reset your password if you can&apos;t get in.</p>
    </RouteError>
  )
}
