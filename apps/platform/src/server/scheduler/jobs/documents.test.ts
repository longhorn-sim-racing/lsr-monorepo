import { generateKeyPairSync } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ readConnectorState: vi.fn(), recordConnectorSync: vi.fn(), recordConnectorError: vi.fn() }))
const clients = vi.hoisted(() => ({ drive: vi.fn(), sharepoint: vi.fn(), teams: vi.fn() }))
const stores = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/connectors/google-drive/connector", async (importOriginal) => ({ ...(await importOriginal<object>()), googleDriveConnector: { client: clients.drive } }))
vi.mock("@/server/connectors/sharepoint/connector", () => ({ SHAREPOINT_CONNECTOR_ID: "sharepoint", SHAREPOINT_SOURCE: "sharepoint", sharePointConnector: { client: clients.sharepoint } }))
vi.mock("@/server/connectors/teams/connector", () => ({ TEAMS_CONNECTOR_ID: "teams", teamsConnector: { client: clients.teams } }))
vi.mock("@/server/connectors/documents/store", () => ({ prismaDocumentStore: () => stores.current }))

import { memoryDocumentStore } from "@/server/connectors/documents/testing"
import { mountFakes } from "@/server/connectors/fakes/testing"
import { driveClient } from "@/server/connectors/google-drive/client"
import { DRIVE_FAKE_ROOT_ID, DRIVE_FAKE_SA_EMAIL } from "@/server/connectors/google-drive/fake/fixtures"
import { googleDriveFake } from "@/server/connectors/google-drive/fake/handlers"
import { DRIVE_ROOT_MISSING } from "@/server/connectors/google-drive/job"
import { JOBS } from "./documents"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const job = (kind: string) => JOBS.find((j) => j.kind === kind)!
const ctx = () => ({ signal: new AbortController().signal, deadline: Date.now() + 120_000, startedAt: Date.now(), log: vi.fn(), config: null, job: { id: "j", key: "k" } })

beforeEach(() => {
  stores.current = memoryDocumentStore("drive")
  state.readConnectorState.mockResolvedValue(null)
  state.recordConnectorSync.mockResolvedValue(undefined)
  state.recordConnectorError.mockResolvedValue("")
  clients.drive.mockResolvedValue(null)
  clients.sharepoint.mockResolvedValue(null)
  clients.teams.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the documents track's jobs", () => {
  it("are the Drive sync, the SharePoint sync and the two Teams jobs; the long ones hand off", () => {
    expect(JOBS.map((j) => [j.kind, j.handoff ?? false])).toEqual([
      ["google-drive.sync", true],
      ["sharepoint.sync", true],
      ["teams.subscriptions", false],
      ["teams.sync", true],
    ])
  })

  it("skip while their connector is switched off or not set up, touching nothing", async () => {
    for (const one of JOBS) {
      const result = await one.run(ctx())
      expect(result.status, one.kind).toBe("skipped")
      expect(result.summary, one.kind).toMatch(/isn't connected/)
    }
    expect(state.recordConnectorSync).not.toHaveBeenCalled()
    expect(state.recordConnectorError).not.toHaveBeenCalled()
  })
})

describe("google-drive.sync", () => {
  const connect = () => clients.drive.mockResolvedValue({ drive: driveClient({ email: DRIVE_FAKE_SA_EMAIL, privateKey }, { retryDelayMs: 0 }), rootId: DRIVE_FAKE_ROOT_ID })

  it("syncs, saving the cursor as it goes and at the end", async () => {
    mountFakes([googleDriveFake])
    connect()
    const result = await job("google-drive.sync").run(ctx())
    expect(result.status).toBeUndefined()
    expect(result.summary).toMatch(/^Read 11 files/)
    expect(state.recordConnectorSync).toHaveBeenLastCalledWith("google-drive", { cursor: expect.objectContaining({ rootId: DRIVE_FAKE_ROOT_ID, pageToken: expect.any(String) }) })
    expect(state.recordConnectorSync.mock.calls.length).toBeGreaterThan(2)
  })

  it("fails, and records the connector's error, when the shared folder is gone", async () => {
    const fakes = mountFakes([googleDriveFake])
    connect()
    await job("google-drive.sync").run(ctx())
    await fetch(`${fakes.origin}/google-drive/_fake/mutate`, { method: "POST", body: JSON.stringify({ op: "unshare-root" }) })
    state.readConnectorState.mockResolvedValue({ cursor: state.recordConnectorSync.mock.calls.at(-1)![1].cursor })
    await expect(job("google-drive.sync").run(ctx())).rejects.toThrow(DRIVE_ROOT_MISSING)
    expect(state.recordConnectorError).toHaveBeenCalledWith("google-drive", expect.objectContaining({ message: expect.stringContaining(DRIVE_ROOT_MISSING) }))
    // The cursor (with the removals the feed reported) was saved before the error
    expect(state.recordConnectorSync).toHaveBeenLastCalledWith("google-drive", { cursor: expect.objectContaining({ rootMissingAt: expect.any(String) }) })
  })
})
