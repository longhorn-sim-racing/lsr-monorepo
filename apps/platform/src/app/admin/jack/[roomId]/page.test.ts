import { isValidElement, type ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { roomMessageUrl } from "@/lib/jack/proposals"

const guards = vi.hoisted(() => ({ requireOfficerPage: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
const rooms = vi.hoisted(() => ({ getRoomSnapshot: vi.fn(), listRooms: vi.fn() }))
vi.mock("@/server/jack/rooms", () => rooms)
vi.mock("@/server/jack/spend", () => ({ getMonthSpend: vi.fn(async () => null) }))
vi.mock("./room-client", () => ({ JackRoomClient: () => null }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND")
  },
}))

import JackRoomPage from "./page"

const ROOM = "6f2c1d4e-8a7b-4c3d-9e2f-1a2b3c4d5e6f"
const REPLY = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9"

/** Opens the room page at a URL the way Next.js hands it the params */
async function open(url: string) {
  const { pathname, searchParams } = new URL(url, "http://localhost")
  const roomId = pathname.split("/").at(-1)!
  const element = await JackRoomPage({ params: Promise.resolve({ roomId }), searchParams: Promise.resolve(Object.fromEntries(searchParams)) })
  if (!isValidElement(element)) throw new Error("the page rendered nothing")
  return element as ReactElement<{ anchorId?: string }>
}

beforeEach(() => {
  guards.requireOfficerPage.mockResolvedValue({ id: "officer-1", displayName: "Gray", avatarUrl: null })
  rooms.listRooms.mockResolvedValue([])
  rooms.getRoomSnapshot.mockResolvedValue({ room: { id: ROOM }, messages: [{ id: "earlier" }, { id: REPLY }], proposals: {} })
})

describe("a proposal's link from the Proposals page", () => {
  it("opens its room at the reply that proposed it", async () => {
    const page = await open(roomMessageUrl(ROOM, REPLY))
    expect(rooms.getRoomSnapshot).toHaveBeenCalledWith(ROOM, { around: REPLY })
    expect(page.props.anchorId).toBe(REPLY)
  })

  it("opens the room at the latest messages for a proposal with no reply, or one no longer in the room", async () => {
    expect((await open(roomMessageUrl(ROOM, null))).props.anchorId).toBeUndefined()
    expect(rooms.getRoomSnapshot).toHaveBeenLastCalledWith(ROOM, { around: undefined })

    rooms.getRoomSnapshot.mockResolvedValue({ room: { id: ROOM }, messages: [{ id: "earlier" }], proposals: {} })
    expect((await open(roomMessageUrl(ROOM, REPLY))).props.anchorId).toBeUndefined()
  })
})
