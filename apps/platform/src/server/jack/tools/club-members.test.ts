import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  user: { groupBy: vi.fn(), findMany: vi.fn() },
  userRole: { findMany: vi.fn() },
  userMembership: { findMany: vi.fn() },
  entitlement: { findMany: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { clubMembersTool } from "./club-members"

const officers = [
  {
    displayName: "Diane Chagoya",
    handle: "diane-chagoya",
    officerTitle: "Media Lead",
    department: "media",
    isBoard: true,
    workingOn: "Photos, video and the brand",
    major: "Radio-Television-Film",
    gradYear: 2027,
    email: "diane@example.com",
    eid: "dc123",
    roles: [{ role: { key: "officer" } }],
  },
  {
    displayName: "New Officer",
    handle: "new-officer",
    officerTitle: null,
    department: null,
    isBoard: false,
    workingOn: null,
    major: null,
    gradYear: null,
    email: "new@example.com",
    eid: null,
    roles: [{ role: { key: "officer" } }],
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  db.user.groupBy.mockResolvedValue([{ status: "active", _count: { _all: 2 } }])
  // The officer roster is the query that filters by role; the counts get no rows here
  db.user.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => ("roles" in where ? officers : []))
  db.userRole.findMany.mockResolvedValue([])
  db.userMembership.findMany.mockResolvedValue([])
  db.entitlement.findMany.mockResolvedValue([])
})

describe("club_members officers", () => {
  it("gives each officer's department, board seat, what they work on, major and grad year", async () => {
    const result = await clubMembersTool.run(clubMembersTool.input.parse({ roster: "officers", newest: 0 }), { roomId: "room-1", actor: { userId: "u1", displayName: "Gray" } })
    const select = db.user.findMany.mock.calls.find(([args]) => "roles" in args.where)![0].select
    expect(select).toMatchObject({ department: true, isBoard: true, workingOn: true, major: true, gradYear: true })

    const body = JSON.parse(result.forModel)
    expect(body.roster).toEqual([
      {
        name: "Diane Chagoya",
        handle: "diane-chagoya",
        title: "Media Lead",
        department: "Media",
        board: true,
        workingOn: "Photos, video and the brand",
        major: "Radio-Television-Film",
        gradYear: 2027,
        roles: ["officer"],
        email: "diane@example.com",
        eid: "dc123",
      },
      // Empty fields are left out, as in the member roster
      { name: "New Officer", handle: "new-officer", roles: ["officer"], email: "new@example.com" },
    ])
    expect(body.rosterDefinitions).toMatch(/department is their team/)
    expect(result.displays?.[0]).toMatchObject({
      kind: "table",
      columns: ["Officer", "Title", "Department", "Works on", "Roles", "Email"],
      rows: [
        ["Diane Chagoya", "Media Lead", "Media · board", "Photos, video and the brand", "officer", "diane@example.com"],
        ["New Officer", null, null, null, "officer", "new@example.com"],
      ],
    })
  })
})
