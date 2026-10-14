"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Radio } from "lucide-react"
import { Button } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import { central } from "@/app/admin/events/_components/format"

/** Refreshes the page every 3 seconds while on, so check-ins and sign-ups show up as they happen. */
export function LiveTailButton() {
  const [isLive, setIsLive] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const router = useRouter()

  useEffect(() => {
    if (!isLive) return
    const interval = setInterval(() => {
      router.refresh()
      setLastRefreshed(new Date())
    }, 3000)
    return () => clearInterval(interval)
  }, [isLive, router])

  return (
    <div className="flex items-center gap-2">
      {isLive && lastRefreshed && (
        <span className="text-xs text-admin-subtle">
          Updated {central(lastRefreshed, "h:mm:ss a")}
        </span>
      )}
      <Button aria-pressed={isLive} onClick={() => setIsLive(!isLive)} title={isLive ? "Stop refreshing" : "Refresh every 3 seconds"}>
        {isLive ? (
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-tone-success-foreground opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-tone-success-foreground" />
          </span>
        ) : (
          <Radio aria-hidden />
        )}
        <span className={cn(isLive && "font-semibold")}>{isLive ? "Live" : "Go live"}</span>
      </Button>
    </div>
  )
}
