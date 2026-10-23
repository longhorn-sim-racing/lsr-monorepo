"use client"

import { useOptimistic, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Badge, EmptyState, SwitchField, useConfirm } from "@/components/admin/kit"
import { setDiscordChannelSyncedAction } from "./actions"

export type ChannelItem = {
  id: string
  name: string
  kind: string
  category: string | null
  synced: boolean
  threads: number
  messages30: number
  /** "5 minutes ago", or null when it hasn't synced */
  lastSync: string | null
}

/** One channel: what it is, its last 30 days, and the sync switch (admins) or its state (officers) */
function ChannelRow({ channel, isAdmin }: { channel: ChannelItem; isAdmin: boolean }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [saving, startSave] = useTransition()
  const [synced, setOptimistic] = useOptimistic(channel.synced)

  async function toggle(next: boolean) {
    const ok = await confirm(
      next
        ? {
            title: `Sync #${channel.name}?`,
            description:
              "The sync records who posted when in this channel and its threads (never what they wrote), reading back up to 90 days the first time. Jack can then search its messages live. Members can see the server's privacy note.",
            confirmLabel: "Sync it",
          }
        : {
            title: `Stop syncing #${channel.name}?`,
            description: "Everything stored from it is deleted: its message records and its daily counts. Jack stops searching it too. Syncing it again reads it back from scratch.",
            confirmLabel: "Stop and delete",
            tone: "danger",
          },
    )
    if (!ok) return
    startSave(async () => {
      setOptimistic(next)
      try {
        const result = await setDiscordChannelSyncedAction(channel.id, next)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(next ? `#${channel.name} syncs from the next run` : `#${channel.name} stopped syncing${result.data.deleted ? ` (${result.data.deleted} records deleted)` : ""}`)
        router.refresh()
      } catch {
        toast.error("Couldn't change it. Try again.")
      }
    })
  }

  const detail = [channel.kind, channel.threads ? `${channel.threads} ${channel.threads === 1 ? "thread" : "threads"}` : null, `${channel.messages30.toLocaleString("en-US")} messages in 30 days`, channel.lastSync ? `synced ${channel.lastSync}` : null]
    .filter(Boolean)
    .join(" · ")

  return (
    <li className="flex min-h-11 items-center justify-between gap-3 border-b border-admin-row px-4 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-semibold">#{channel.name}</span>
        <span className="truncate text-xs text-admin-subtle">{detail}</span>
      </span>
      {isAdmin ? (
        <SwitchField
          label={synced ? "Synced" : "Off"}
          aria-label={`Sync #${channel.name}: ${synced ? "on" : "off"}`}
          checked={synced}
          onCheckedChange={toggle}
          disabled={saving}
          className="shrink-0 items-center gap-2.5"
        />
      ) : (
        <Badge tone={channel.synced ? "success" : "neutral"}>{channel.synced ? "Synced" : "Off"}</Badge>
      )}
    </li>
  )
}

/** The server's channels by category, each with its sync switch */
export function ChannelList({ channels, isAdmin }: { channels: ChannelItem[]; isAdmin: boolean }) {
  if (!channels.length) {
    return <EmptyState title="No channels yet" description="They appear after the first Discord sync reads the server's channel list." />
  }
  const groups = new Map<string, ChannelItem[]>()
  for (const channel of channels) {
    const key = channel.category ?? "No category"
    groups.set(key, [...(groups.get(key) ?? []), channel])
  }
  return (
    <div className="flex flex-col">
      {[...groups].map(([category, list]) => (
        <div key={category}>
          <p className="border-b border-admin-row bg-admin-surface px-4 py-1.5 text-xs font-semibold text-muted-foreground">{category}</p>
          <ul>
            {list.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} isAdmin={isAdmin} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
