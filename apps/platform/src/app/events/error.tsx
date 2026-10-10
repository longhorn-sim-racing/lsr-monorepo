"use client"

import { RouteError } from "@/components/route-error"

export default function EventsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      error={error}
      reset={reset}
      kicker="Events"
      title={
        <>
          Couldn&apos;t load <span className="text-lsr-orange">events</span>
        </>
      }
      back={{ href: "/", label: "Back to the homepage" }}
    >
      <p>Something broke on our side while loading this page. Your registrations are safe; try again in a moment.</p>
    </RouteError>
  )
}
