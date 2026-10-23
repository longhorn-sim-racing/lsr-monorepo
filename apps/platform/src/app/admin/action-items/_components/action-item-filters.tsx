"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Segmented, Select, Toolbar } from "@/components/admin/kit"

export type ItemStatusView = "open" | "overdue" | "done" | "dropped" | "all"

const STATUS_LABEL: Record<ItemStatusView, string> = { open: "Open", overdue: "Overdue", done: "Done", dropped: "Dropped", all: "All" }

/** Status and owner for the action items list, kept in the URL */
export function ActionItemFilters({ counts, owners }: { counts: Record<ItemStatusView, number>; owners: { handle: string; displayName: string }[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const status = (searchParams.get("status") as ItemStatusView | null) ?? "open"
  const owner = searchParams.get("owner") ?? ""

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    const query = next.toString()
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }))
  }

  return (
    <Toolbar actions={isPending ? <Loader2 className="size-4 animate-spin text-admin-subtle" aria-label="Loading" /> : undefined}>
      <Segmented
        label="Which action items"
        value={status in STATUS_LABEL ? status : "open"}
        onChange={(value) => setParam("status", value === "open" ? "" : value)}
        options={(Object.keys(STATUS_LABEL) as ItemStatusView[]).map((key) => ({ value: key, label: STATUS_LABEL[key], count: counts[key] }))}
      />
      <Select aria-label="Owner" value={owner} onChange={(event) => setParam("owner", event.target.value)} className="w-auto min-w-40">
        <option value="">Everyone</option>
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
