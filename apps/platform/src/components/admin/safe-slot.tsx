import type { ReactNode } from "react"
import { Notice } from "@/components/admin/kit"

/**
 * Renders one server component a Jack 2.0 track plugged into a shared page (an Overview card, an
 * Instagram section). If loading its data throws, a short notice takes its place, so one failing
 * source never takes the whole page down.
 */
export async function SafeSlot({ id, where, render }: { id: string; where: string; render: () => Promise<ReactNode> | ReactNode }) {
  try {
    return await render()
  } catch (error) {
    console.error(`[${where}] The ${id} slot failed:`, error)
    return (
      <Notice tone="warning" title="Couldn't load this part of the page">
        The rest of the page is up to date. Reload to try again.
      </Notice>
    )
  }
}
