import type { Metadata } from "next"
import { EmptyState, PageHeader, Panel, PanelBody, PanelHeader, SplitLayout } from "@/components/admin/kit"
import { requireOfficerPage } from "@/server/auth/guards"
import { actionItemCounts, actionItemOwners, listActionItems, type ActionItemRow } from "@/server/queries/meetings"
import { listOfficers } from "@/server/services/officers"
import { prisma } from "@/server/db"
import { ActionItemList, AddActionItemForm } from "./_components/action-items"
import { ActionItemFilters, type ItemStatusView } from "./_components/action-item-filters"
import { actionItemView } from "./_components/view"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Action items" }

const STATUSES: ItemStatusView[] = ["open", "overdue", "done", "dropped", "all"]

const EMPTY: Record<ItemStatusView, string> = {
  open: "Nothing open. Add an item here, on a meeting's page, or ask Jack to record a meeting.",
  overdue: "Nothing overdue.",
  done: "Nothing marked done yet.",
  dropped: "Nothing dropped.",
  all: "No action items yet. Add one here, on a meeting's page, or ask Jack to record a meeting.",
}

type Group = { key: string; name: string; items: ActionItemRow[]; overdue: number; open: number }

/** Items grouped by owner: owners with the most overdue first, then by name, nobody's last */
function byOwner(items: ActionItemRow[]): Group[] {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const key = item.owner?.id ?? ""
    const group = groups.get(key) ?? { key, name: item.owner?.displayName ?? "No owner", items: [], overdue: 0, open: 0 }
    group.items.push(item)
    if (item.overdue) group.overdue += 1
    if (item.status === "open") group.open += 1
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => (a.key === "") !== (b.key === "") ? (a.key === "" ? 1 : -1) : b.overdue - a.overdue || a.name.localeCompare(b.name))
}

/**
 * Club → Action items (#188, design §13): what officers said they'd do, by owner, overdue first. Any
 * officer adds items, edits them and marks them done; meetings and Jack's proposals add them too.
 */
export default async function ActionItemsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()
  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return (Array.isArray(value) ? value[0] : value) ?? ""
  }
  const status: ItemStatusView = (STATUSES as string[]).includes(one("status")) ? (one("status") as ItemStatusView) : "open"
  const ownerHandle = one("owner")
  const now = new Date()

  const owner = ownerHandle && ownerHandle !== "none" ? await prisma.user.findUnique({ where: { handle: ownerHandle.toLowerCase() }, select: { id: true, displayName: true } }) : null
  const ownerId = ownerHandle === "none" ? null : owner ? owner.id : undefined
  const [items, counts, owners, officers] = await Promise.all([
    ownerHandle && ownerHandle !== "none" && !owner ? Promise.resolve([]) : listActionItems({ status, ...(ownerId !== undefined ? { ownerId } : {}) }, now),
    actionItemCounts(now),
    actionItemOwners(),
    listOfficers(),
  ])
  const groups = byOwner(items)
  const pickers = officers.map((o) => ({ id: o.id, displayName: o.displayName }))

  return (
    <>
      <PageHeader
        title="Action items"
        description={`What officers said they'd do: ${counts.open} open${counts.overdue ? `, ${counts.overdue} overdue` : ""}. Overdue means open and past its due date.`}
      />
      <ActionItemFilters counts={{ ...counts }} owners={owners.map((o) => ({ handle: o.handle, displayName: o.displayName }))} />
      <SplitLayout
        main={
          groups.length === 0 ? (
            <Panel>
              <EmptyState title={owner ? `Nothing here for ${owner.displayName}` : "Nothing here"} description={EMPTY[status]} />
            </Panel>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <Panel key={group.key || "none"}>
                  <PanelHeader title={group.name} description={[group.open ? `${group.open} open` : null, group.overdue ? `${group.overdue} overdue` : null, status !== "open" && status !== "overdue" ? `${group.items.length} shown` : null].filter(Boolean).join(" · ") || undefined} />
                  <ActionItemList items={group.items.map((item) => actionItemView(item, now))} officers={pickers} />
                </Panel>
              ))}
            </div>
          )
        }
        side={
          <Panel>
            <PanelHeader title="Add an action item" description="For one that came from a meeting, add it on the meeting's page instead." />
            <PanelBody>
              <AddActionItemForm officers={pickers} />
            </PanelBody>
          </Panel>
        }
      />
    </>
  )
}
