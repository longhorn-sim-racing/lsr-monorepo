import type { ReactNode } from "react"
import { unstable_rethrow } from "next/navigation"
import { Notice } from "@/components/admin/kit"

/**
 * Renders one server component a Jack 2.0 track plugged into a shared page (an Overview card, an
 * Instagram section). If its own top-level render throws (usually loading its data), a short notice
 * takes its place, so one failing source never takes the whole page down. It only guards that call:
 * an error in a component it renders further down still reaches the page's error boundary. Next.js's
 * own signals (redirect, notFound, a dynamic-rendering bailout) are rethrown, never swallowed.
 */
export async function SafeSlot({ id, where, render }: { id: string; where: string; render: () => Promise<ReactNode> | ReactNode }) {
  try {
    return await render()
  } catch (error) {
    unstable_rethrow(error)
    console.error(`[${where}] The ${id} slot failed:`, error)
    return (
      <Notice tone="warning" title="Couldn't load this part of the page">
        The rest of the page is up to date. Reload to try again.
      </Notice>
    )
  }
}
