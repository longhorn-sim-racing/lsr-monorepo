"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDebouncedCallback } from "use-debounce"
import { Loader2 } from "lucide-react"
import { SearchInput, Segmented, Toolbar } from "@/components/admin/kit"
import type { KnowledgeView } from "@/server/jack/knowledge/queries"

const VIEW_LABEL: Record<KnowledgeView, string> = {
  active: "All",
  unreviewed: "Not reviewed",
  stale: "Over 6 months old",
  archived: "Archived",
}

/** Search and view for the entries list. They live in the URL so a filtered list can be shared */
export function KnowledgeFilters({ counts }: { counts: Record<KnowledgeView, number> }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const urlQuery = searchParams.get("q") ?? ""
  const [term, setTerm] = useState(urlQuery)
  const [seenQuery, setSeenQuery] = useState(urlQuery)

  // Follow URL changes made elsewhere (back button, a sidebar link) without clobbering typing
  if (urlQuery !== seenQuery) {
    setSeenQuery(urlQuery)
    if (urlQuery !== term.trim()) setTerm(urlQuery)
  }

  const view = (searchParams.get("view") as KnowledgeView | null) ?? "active"

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete("page")
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
        placeholder="Search titles, text and tags"
      />
      <Segmented
        label="Which entries"
        value={view in VIEW_LABEL ? view : "active"}
        onChange={(value) => setParam("view", value === "active" ? "" : value)}
        options={(Object.keys(VIEW_LABEL) as KnowledgeView[]).map((key) => ({ value: key, label: VIEW_LABEL[key], count: counts[key] }))}
      />
    </Toolbar>
  )
}
