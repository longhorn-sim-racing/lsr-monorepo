"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDebouncedCallback } from "use-debounce"
import { Loader2 } from "lucide-react"
import { SearchInput, Segmented, Toolbar } from "@/components/admin/kit"
import { MEETING_TYPE_LABEL, MEETING_TYPES, type MeetingType } from "@/lib/meetings"

/** Search and type for the meetings list, kept in the URL */
export function MeetingFilters({ counts }: { counts: Record<MeetingType | "all", number> }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const urlQuery = searchParams.get("q") ?? ""
  const [term, setTerm] = useState(urlQuery)
  const [seenQuery, setSeenQuery] = useState(urlQuery)

  if (urlQuery !== seenQuery) {
    setSeenQuery(urlQuery)
    if (urlQuery !== term.trim()) setTerm(urlQuery)
  }

  const type = searchParams.get("type") ?? "all"
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    const query = next.toString()
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }))
  }
  const applySearch = useDebouncedCallback((value: string) => setParam("q", value.trim()), 300)

  return (
    <Toolbar actions={isPending ? <Loader2 className="size-4 animate-spin text-admin-subtle" aria-label="Loading" /> : undefined}>
      <SearchInput
        value={term}
        onChange={(value) => {
          setTerm(value)
          applySearch(value)
        }}
        placeholder="Search titles, agendas, summaries"
      />
      <Segmented
        label="Meeting type"
        value={(MEETING_TYPES as readonly string[]).includes(type) ? type : "all"}
        onChange={(value) => setParam("type", value === "all" ? "" : value)}
        options={[{ value: "all", label: "All", count: counts.all }, ...MEETING_TYPES.map((t) => ({ value: t, label: MEETING_TYPE_LABEL[t], count: counts[t] }))]}
      />
    </Toolbar>
  )
}
