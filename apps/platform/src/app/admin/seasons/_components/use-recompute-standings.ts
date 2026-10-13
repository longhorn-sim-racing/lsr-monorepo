"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useConfirm } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { recomputeStandings } from "../actions"

/** Confirms, then recomputes a season's standings from its ingested results, reporting the outcome in a toast. */
export function useRecomputeStandings() {
  const confirm = useConfirm()
  const [pendingId, setPendingId] = useState<string | null>(null)

  async function recompute(season: { id: string; name: string }) {
    const ok = await confirm({
      title: `Recompute standings for ${season.name}?`,
      description:
        "Recalculates every driver's points and stats from the ingested race results in this season's series and dates. Manual edits to the standings are overwritten.",
      confirmLabel: "Recompute",
    })
    if (!ok) return
    setPendingId(season.id)
    try {
      const result = await recomputeStandings(season.id)
      if (result.ok) toast.success(`Standings recomputed for ${season.name}`)
      else toast.error(result.error)
    } catch (error) {
      console.error(error)
      toast.error(unexpectedError(error, "Couldn't recompute the standings"))
    } finally {
      setPendingId(null)
    }
  }

  return { recompute, pendingId }
}
