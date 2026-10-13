"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDebouncedCallback } from "use-debounce"
import { Loader2, X } from "lucide-react"
import { Button, SearchInput, Select, Toolbar } from "@/components/admin/kit"
import { PAYMENT_KIND_LABELS, PAYMENT_STATUSES } from "@/lib/payments"

/** Search, status and kind for the payments list. They live in the URL so a filtered list can be shared. */
export function PaymentsFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const urlQuery = searchParams.get("q") ?? ""
  const [term, setTerm] = useState(urlQuery)
  const [seenQuery, setSeenQuery] = useState(urlQuery)

  // Follow URL changes made elsewhere (back button, sidebar link) without clobbering typing.
  if (urlQuery !== seenQuery) {
    setSeenQuery(urlQuery)
    if (urlQuery !== term.trim()) setTerm(urlQuery)
  }

  const status = searchParams.get("status") ?? ""
  const kind = searchParams.get("kind") ?? ""
  const hasFilters = Boolean(status || kind || urlQuery)

  const navigate = (next: URLSearchParams) => {
    next.delete("page")
    const query = next.toString()
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }))
  }

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    navigate(next)
  }

  const applySearch = useDebouncedCallback((value: string) => setParam("q", value.trim()), 300)

  const clear = () => {
    applySearch.cancel()
    setTerm("")
    navigate(new URLSearchParams())
  }

  return (
    <Toolbar
      actions={isPending ? <Loader2 className="size-4 animate-spin text-admin-subtle" aria-label="Loading" /> : undefined}
    >
      <SearchInput
        value={term}
        onChange={(value) => {
          setTerm(value)
          applySearch(value)
        }}
        placeholder="Search name, handle or email"
      />
      <Select aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value)} className="w-auto">
        <option value="">All statuses</option>
        {PAYMENT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </option>
        ))}
      </Select>
      <Select aria-label="Kind" value={kind} onChange={(e) => setParam("kind", e.target.value)} className="w-auto">
        <option value="">All kinds</option>
        {Object.entries(PAYMENT_KIND_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      {hasFilters && (
        <Button variant="ghost" onClick={clear}>
          <X aria-hidden />
          Clear
        </Button>
      )}
    </Toolbar>
  )
}
