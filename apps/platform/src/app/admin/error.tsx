"use client"

import { useEffect, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/admin/kit"

// Renders inside the admin layout, so the sidebar stays and officers can go elsewhere
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter()
  const [retrying, startRetry] = useTransition()

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div role="alert" className="mx-auto mt-10 max-w-xl rounded-lg border border-tone-danger-foreground/25 bg-card p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-tone-danger-foreground" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">This admin page hit an error</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Try again, or open another section from the sidebar.
            {error.digest ? " If it keeps happening, send the reference below to the Tech Team." : " If it keeps happening, tell the Tech Team what you were doing."}
          </p>
          {error.digest && <p className="mt-3 font-mono text-xs text-admin-subtle">Reference: {error.digest}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              pending={retrying}
              onClick={() =>
                startRetry(() => {
                  router.refresh()
                  reset()
                })
              }
            >
              {retrying ? "Trying again" : "Try again"}
            </Button>
            <Button asChild>
              <Link href="/admin">Admin overview</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
