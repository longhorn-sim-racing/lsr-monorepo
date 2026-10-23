"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDebouncedCallback } from "use-debounce"
import { Loader2 } from "lucide-react"
import { SearchInput, Segmented, Select, Toolbar } from "@/components/admin/kit"
import type { ProspectView } from "@/server/queries/sponsor-prospects"

const VIEW_LABEL: Record<ProspectView, string> = {
  active: "Being worked on",
  committed: "Committed",
  quiet: "Quiet",
  closed: "Declined or dormant",
  all: "All",
}

/** Search, view and owner for the prospects list. They live in the URL so a filtered list can be shared */
export function ProspectFilters({ counts, owners }: { counts: Record<ProspectView, number>; owners: { handle: string; displayName: string }[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const urlQuery = searchParams.get("q") ?? ""
  const [term, setTerm] = useState(urlQuery)
  const [seenQuery, setSeenQuery] = useState(urlQuery)

  // Follow URL changes made elsewhere (back button, a link) without clobbering typing
  if (urlQuery !== seenQuery) {
    setSeenQuery(urlQuery)
    if (urlQuery !== term.trim()) setTerm(urlQuery)
  }

  const view = (searchParams.get("view") as ProspectView | null) ?? "active"
  const owner = searchParams.get("owner") ?? ""

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
        placeholder="Search companies, contacts, notes"
      />
      <Segmented
        label="Which prospects"
        value={view in VIEW_LABEL ? view : "active"}
        onChange={(value) => setParam("view", value === "active" ? "" : value)}
        options={(Object.keys(VIEW_LABEL) as ProspectView[]).map((key) => ({ value: key, label: VIEW_LABEL[key], count: counts[key] }))}
      />
      <Select aria-label="Owner" value={owner} onChange={(event) => setParam("owner", event.target.value)} className="w-auto min-w-40">
        <option value="">Any owner</option>
        <option value="none">No owner</option>
        {owners.map((o) => (
          <option key={o.handle} value={o.handle}>
            {o.displayName}
          </option>
        ))}
      </Select>
    </Toolbar>
  )
}
