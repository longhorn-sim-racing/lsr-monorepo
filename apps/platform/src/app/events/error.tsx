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
          Couldn&apos;t load <span className="text-lsr-orange">this event</span>
        </>
      }
      back={{ href: "/events", label: "All events" }}
    >
      <p>Something broke on our side while loading the schedule. Your registrations are safe; try again in a moment.</p>
    </RouteError>
  )
}
