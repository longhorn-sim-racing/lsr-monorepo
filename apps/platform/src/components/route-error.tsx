"use client"

import { useEffect, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { StatusScreen, statusPrimary, statusSecondary } from "@/components/status-screen"

/**
 * The body of an error.tsx: logs the error, offers Try again and a way back, and shows the digest
 * (never the message, which can hold internals) so people can quote it when they report it.
 */
export function RouteError({
  error,
  reset,
  code,
  kicker,
  title,
  children,
  back,
}: {
  error: Error & { digest?: string }
  reset: () => void
  code?: string
  kicker: string
  title: React.ReactNode
  children: React.ReactNode
  back: { href: string; label: string }
}) {
  const router = useRouter()
  const [retrying, startRetry] = useTransition()

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <StatusScreen
      code={code}
      kicker={kicker}
      title={title}
      actions={
        <>
          {/* refresh() refetches the server data; reset() alone would re-render the payload that failed */}
          <button
            type="button"
            disabled={retrying}
            onClick={() => startRetry(() => { router.refresh(); reset() })}
            className={statusPrimary}
          >
            {retrying ? "Trying again..." : "Try again"}
          </button>
          <Link href={back.href} className={statusSecondary}>
            {back.label}
          </Link>
        </>
      }
    >
      {children}
      <p className="mt-4 text-base text-white/60">
        If it keeps happening, email{" "}
        <a href="mailto:info@longhornsimracing.org" className="font-bold text-lsr-orange hover:text-white">
          info@longhornsimracing.org
        </a>{" "}
        and tell us what you were doing.
      </p>
      {error.digest && <p className="mt-4 font-mono text-xs text-white/40">Reference: {error.digest}</p>}
    </StatusScreen>
  )
}
