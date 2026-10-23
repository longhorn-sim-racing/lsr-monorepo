import { discordConnector } from "@/server/connectors/discord/connector"
import { discordWeek, type DiscordWeek } from "@/server/queries/discord"
import { OverviewPanel } from "../overview-list"
import type { OverviewCard } from "./types"

/** "120 messages, up 20% on the week before" */
export function weekLine(week: DiscordWeek): string {
  const count = `${week.messages.toLocaleString("en-US")} ${week.messages === 1 ? "message" : "messages"}`
  if (!week.previousMessages) return count
  const change = Math.round(((week.messages - week.previousMessages) / week.previousMessages) * 100)
  return change === 0 ? `${count}, same as the week before` : `${count}, ${change > 0 ? "up" : "down"} ${Math.abs(change)}% on the week before`
}

/**
 * Discord this week (design §13): messages against the week before, active members, the member count,
 * and the busiest channels. Counts only. Nothing shows until Discord is set up and has synced something.
 */
export const discordActivityCard: OverviewCard = {
  id: "discord-activity",
  order: 40,
  async Card() {
    const status = await discordConnector.status()
    if (!status.configured && !status.lastSyncAt) return null
    const week = await discordWeek()
    if (!week.synced && !week.messages && week.memberCount === null) return null
    const members = week.memberCount === null ? null : `${week.memberCount.toLocaleString("en-US")} members${week.memberChange ? ` (${week.memberChange > 0 ? "+" : "−"}${Math.abs(week.memberChange)} this week)` : ""}`
    return (
      <OverviewPanel
        title="Discord this week"
        description={[weekLine(week), `${week.activeMembers} active ${week.activeMembers === 1 ? "member" : "members"}`, members].filter(Boolean).join(" · ")}
        viewAll={{ href: "/admin/discord", label: "Discord" }}
        empty={week.synced ? "No messages in the synced channels this week." : "No channels sync yet: an admin picks them on the Discord page."}
        items={week.topChannels.map((channel) => ({
          key: channel.name,
          href: "/admin/discord",
          primary: `#${channel.name}`,
          meta: `${channel.messages.toLocaleString("en-US")} ${channel.messages === 1 ? "message" : "messages"}`,
        }))}
      />
    )
  },
}

/** Overview cards from the discord-read track. The registry joins every track's cards and sorts them by order */
export const CARDS: OverviewCard[] = [discordActivityCard]
