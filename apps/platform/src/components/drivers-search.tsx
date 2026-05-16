"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Input } from "@/components/ui/input"

export function DriversSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlQuery = searchParams?.get("q") ?? ""
  const [term, setTerm] = React.useState(urlQuery)

  // Sync local state if the URL changes externally (back/forward nav, clear filter etc.)
  React.useEffect(() => setTerm(urlQuery), [urlQuery])

  // Debounce URL updates
  React.useEffect(() => {
    const id = setTimeout(() => {
      const sp = new URLSearchParams(searchParams ?? undefined)
      if (term.trim()) sp.set("q", term.trim())
      else sp.delete("q")
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    }, 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  return (
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="SEARCH DRIVERS..."
        className="h-9 w-[260px] rounded-none border-white/10 bg-white/5 font-sans font-bold text-[10px] uppercase tracking-widest focus:border-lsr-orange focus:ring-lsr-orange placeholder:text-white/30 transition-all"
      />
  )
}
