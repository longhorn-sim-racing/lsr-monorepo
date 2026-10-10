"use client"

import { useEffect } from "react"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"

// Renders inside the admin layout, so the sidebar stays and officers can go elsewhere
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div role="alert" className="mx-auto mt-10 max-w-2xl border border-red-400/30 bg-red-500/[0.06] p-6 font-sans">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-base font-bold text-white">This admin page hit an error</h1>
          <p className="mt-1 text-sm leading-relaxed text-white/70">
            Try again, or open another section from the sidebar. If it keeps happening, send the reference below to the Tech Team.
          </p>
          {error.digest && <p className="mt-3 font-mono text-xs text-white/50">Reference: {error.digest}</p>}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex h-9 items-center bg-lsr-orange px-4 text-xs font-bold uppercase tracking-wider text-white hover:bg-lsr-orange/90"
            >
              Try again
            </button>
            <Link
              href="/admin"
              className="inline-flex h-9 items-center border border-white/20 px-4 text-xs font-bold uppercase tracking-wider text-white/80 hover:border-white/40 hover:text-white"
            >
              Admin dashboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
