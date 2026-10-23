"use client"

import { useTransition } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Select } from "@/components/admin/kit"

/** Which month the Usage page shows. It lives in the URL (?month=2026-10), so a month can be shared */
export function UsageMonthSelect({ months, value, current }: { months: { key: string; label: string }[]; value: string; current: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex items-center gap-2">
      {isPending ? <Loader2 className="size-4 animate-spin text-admin-subtle" aria-label="Loading" /> : null}
      <Select
        aria-label="Month"
        value={value}
        onChange={(e) => {
          const key = e.target.value
          startTransition(() => router.replace(key === current ? pathname : `${pathname}?month=${key}`, { scroll: false }))
        }}
        className="w-auto"
      >
        {months.map((month) => (
          <option key={month.key} value={month.key}>
            {month.label}
            {month.key === current ? " (this month)" : ""}
          </option>
        ))}
      </Select>
    </div>
  )
}
