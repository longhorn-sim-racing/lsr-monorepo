import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ connectorState: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { DRIVE_ROOT_MISSING } from "@/server/connectors/google-drive/connector"
import { CHECKS } from "./documents"

const check = (id: string) => CHECKS.find((c) => c.id === id)!
const now = new Date("2026-10-22T18:00:00Z")
const earlier = new Date("2026-10-22T12:00:00Z")
const row = (id: string, fields: Partial<{ enabled: boolean; lastSyncAt: Date | null; lastError: string | null; lastErrorAt: Date | null }> = {}) => ({ id, enabled: true, lastSyncAt: earlier, lastError: null, lastErrorAt: null, ...fields })

beforeEach(() => {
  db.connectorState.findMany.mockResolvedValue([])
})

describe("documents.drive-folder", () => {
  it("flags a switched-on Drive whose last error is the missing folder", async () => {
    db.connectorState.findMany.mockResolvedValue([row("google-drive", { lastError: `${DRIVE_ROOT_MISSING} (404). Ask its owner…`, lastErrorAt: now })])
    const result = await check("documents.drive-folder").run({ now })
    expect(result).toMatchObject({ count: 1, severity: "danger", items: [{ href: "/admin/connections" }] })
    expect(JSON.stringify(result)).not.toContain("404")
  })

  it("stays quiet once a sync works again, or while Drive is off", async () => {
    db.connectorState.findMany.mockResolvedValue([row("google-drive", { lastError: DRIVE_ROOT_MISSING, lastErrorAt: earlier, lastSyncAt: now })])
    expect((await check("documents.drive-folder").run({ now })).count).toBe(0)
    db.connectorState.findMany.mockResolvedValue([row("google-drive", { enabled: false, lastError: DRIVE_ROOT_MISSING, lastErrorAt: now })])
    expect((await check("documents.drive-folder").run({ now })).count).toBe(0)
  })
})

describe("documents.sync-failing", () => {
  it("lists each switched-on connector whose last error is newer than its last sync, without the error", async () => {
    db.connectorState.findMany.mockResolvedValue([
      row("sharepoint", { lastError: "Microsoft Graph answered 403 (accessDenied) on /v1.0/drives/x", lastErrorAt: now }),
      row("teams", { lastError: "boom", lastErrorAt: earlier, lastSyncAt: now }),
      row("google-drive", { lastError: DRIVE_ROOT_MISSING, lastErrorAt: now }),
    ])
    const result = await check("documents.sync-failing").run({ now })
    expect(result).toEqual({ count: 1, severity: "warning", items: [{ title: "SharePoint isn't syncing", href: "/admin/connections", detail: "Since Oct 22, 1:00 PM CT" }] })
  })

  it("reads nothing but our three connectors", async () => {
    await check("documents.sync-failing").run({ now })
    expect(db.connectorState.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["google-drive", "sharepoint", "teams"] } } }))
  })
})
