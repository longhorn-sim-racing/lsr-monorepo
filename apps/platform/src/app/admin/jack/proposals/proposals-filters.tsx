"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2, X } from "lucide-react"
import { Button, Select, Toolbar } from "@/components/admin/kit"
import { PROPOSAL_STATUS, PROPOSAL_STATUSES } from "@/lib/jack/proposals"
import type { JackProposalStatusKey } from "@/lib/jack/types"

/** Status and kind for the proposals list. They live in the URL, so a filtered list can be shared */
export function ProposalsFilters({ kinds, counts }: { kinds: string[]; counts: Record<JackProposalStatusKey, number> }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const status = searchParams.get("status") ?? ""
  const kind = searchParams.get("kind") ?? ""

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

  return (
    <Toolbar actions={isPending ? <Loader2 className="size-4 animate-spin text-admin-subtle" aria-label="Loading" /> : undefined}>
      <Select aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value)} className="w-auto">
        <option value="">All statuses</option>
        {PROPOSAL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {PROPOSAL_STATUS[s].label} ({counts[s]})
          </option>
        ))}
      </Select>
      <Select aria-label="Kind" value={kind} onChange={(e) => setParam("kind", e.target.value)} className="w-auto">
        <option value="">All kinds</option>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </Select>
      {(status || kind) && (
        <Button variant="ghost" onClick={() => navigate(new URLSearchParams())}>
          <X aria-hidden />
          Clear
        </Button>
      )}
    </Toolbar>
  )
}
