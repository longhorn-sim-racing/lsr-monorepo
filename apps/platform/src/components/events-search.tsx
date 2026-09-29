"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDebouncedCallback } from "use-debounce"
import { Input } from "@/components/ui/input"

export function EventsSearch() {
  const searchParams = useSearchParams()
  const { replace } = useRouter()
  const pathname = usePathname()

  const urlQuery = searchParams?.get("q") ?? ""

  const handleSearch = useDebouncedCallback((term: string) => {
    const params = new URLSearchParams(searchParams ?? undefined)
    if (term) {
      params.set("q", term)
    } else {
      params.delete("q")
    }
    replace(`${pathname}?${params.toString()}`)
  }, 300)

  return (
    <Input
      type="search"
      placeholder="SEARCH EVENTS..."
      className="md:w-[250px] rounded-none border-white/10 bg-white/5 font-sans font-bold text-[10px] uppercase tracking-widest focus:border-lsr-orange focus:ring-lsr-orange placeholder:text-white/30 transition-all"
      defaultValue={urlQuery}
      onChange={(e) => handleSearch(e.target.value)}
    />
  )
}
