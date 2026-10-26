"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDebouncedCallback } from "use-debounce"
import { Loader2 } from "lucide-react"
import { SearchInput, Segmented, Select, Toolbar, type SegmentOption } from "@/components/admin/kit"

/**
 * Search and one filter for the Documents and Teams messages tabs. Everything lives in the URL (next to
 * `tab`), so a filtered list can be shared; changing anything goes back to the first page.
 */
export function SyncedFilters({
  placeholder,
  segments,
  select,
}: {
  placeholder: string
  /** One-of tabs (the document source) */
  segments?: { param: string; label: string; options: SegmentOption<string>[] }
  /** A dropdown (the Teams channel); "" is "all" */
  select?: { param: string; label: string; options: { value: string; label: string }[] }
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const urlQuery = searchParams.get("q") ?? ""
  const [term, setTerm] = useState(urlQuery)
  const [seenQuery, setSeenQuery] = useState(urlQuery)

  // Follow URL changes made elsewhere (back button) without clobbering typing
  if (urlQuery !== seenQuery) {
    setSeenQuery(urlQuery)
    if (urlQuery !== term.trim()) setTerm(urlQuery)
  }

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
        placeholder={placeholder}
      />
      {segments && segments.options.length > 1 && (
        <Segmented label={segments.label} value={searchParams.get(segments.param) ?? ""} onChange={(value) => setParam(segments.param, value)} options={segments.options} />
      )}
      {select && select.options.length > 1 && (
        <Select aria-label={select.label} value={searchParams.get(select.param) ?? ""} onChange={(event) => setParam(select.param, event.target.value)} className="w-full sm:w-56">
          <option value="">{select.label}: all</option>
          {select.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </Toolbar>
  )
}
