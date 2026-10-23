import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

const connector = vi.hoisted(() => ({ status: vi.fn() }))
const queries = vi.hoisted(() => ({ discordWeek: vi.fn() }))
vi.mock("@/server/connectors/discord/connector", () => ({ discordConnector: connector }))
vi.mock("@/server/queries/discord", () => queries)

import { CARDS, discordActivityCard, weekLine } from "./discord-read"

const week = { messages: 120, previousMessages: 100, activeMembers: 18, memberCount: 403, memberChange: 3, topChannels: [{ name: "general", messages: 90 }], synced: 2 }

beforeEach(() => {
  connector.status.mockResolvedValue({ configured: true, lastSyncAt: "2026-10-22T18:00:00.000Z" })
  queries.discordWeek.mockResolvedValue(week)
})

describe("the Discord Overview card", () => {
  it("is the slot's one card", () => {
    expect(CARDS).toEqual([discordActivityCard])
  })

  it("compares the week with the one before", () => {
    expect(weekLine(week)).toBe("120 messages, up 20% on the week before")
    expect(weekLine({ ...week, messages: 50 })).toBe("50 messages, down 50% on the week before")
    expect(weekLine({ ...week, messages: 100 })).toBe("100 messages, same as the week before")
    expect(weekLine({ ...week, messages: 1, previousMessages: 0 })).toBe("1 message")
  })

  it("shows counts and the busiest channels, linking to the Discord page", async () => {
    const card = (await discordActivityCard.Card()) as ReactElement<{ title: string; description: string; items: { primary: string; meta: string; href: string }[]; viewAll: { href: string } }>
    expect(card.props.title).toBe("Discord this week")
    expect(card.props.description).toBe("120 messages, up 20% on the week before · 18 active members · 403 members (+3 this week)")
    expect(card.props.items).toEqual([{ key: "general", href: "/admin/discord", primary: "#general", meta: "90 messages" }])
    expect(card.props.viewAll.href).toBe("/admin/discord")
  })

  it("shows nothing until Discord is set up or has synced", async () => {
    connector.status.mockResolvedValue({ configured: false, lastSyncAt: null })
    expect(await discordActivityCard.Card()).toBeNull()
    expect(queries.discordWeek).not.toHaveBeenCalled()
    connector.status.mockResolvedValue({ configured: true, lastSyncAt: null })
    queries.discordWeek.mockResolvedValue({ ...week, synced: 0, messages: 0, memberCount: null, topChannels: [] })
    expect(await discordActivityCard.Card()).toBeNull()
  })
})
