"use client"

import { useEffect } from "react"
import Link from "next/link"
import { StatusScreen, statusPrimary, statusSecondary } from "@/components/status-screen"

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <StatusScreen
      code="500"
      kicker="Something went wrong"
      title={
        <>
          Red <span className="text-lsr-orange">flag</span>
        </>
      }
      actions={
        <>
          <button type="button" onClick={() => reset()} className={statusPrimary}>
            Try again
          </button>
          <Link href="/" className={statusSecondary}>
            Back to the homepage
          </Link>
        </>
      }
    >
      <p>
        Something broke on our side while loading this page. Try again, and if it keeps happening, email{" "}
        <a href="mailto:info@longhornsimracing.org" className="font-bold text-lsr-orange hover:text-white">
          info@longhornsimracing.org
        </a>{" "}
        and tell us what you were doing.
      </p>
      {error.digest && <p className="mt-4 font-mono text-xs text-white/40">Reference: {error.digest}</p>}
    </StatusScreen>
  )
}
