import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SchedulerHealth } from "@/server/scheduler/heartbeat"
import type { StorageUsage } from "@/server/jack/files/usage"

const db = vi.hoisted(() => ({ scheduledJob: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))
const heartbeat = vi.hoisted(() => ({ getSchedulerHealth: vi.fn() }))
vi.mock("@/server/scheduler/heartbeat", () => heartbeat)
const usage = vi.hoisted(() => ({ getStorageUsage: vi.fn() }))
vi.mock("@/server/jack/files/usage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/jack/files/usage")>()), ...usage }))

import { SchedulerPanel } from "./scheduler"
import { StoragePanel } from "./storage"

/** The panel's visible text, one space between pieces */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim()

const health = (extra: Partial<SchedulerHealth> = {}): SchedulerHealth => ({
  lastTickAt: new Date(Date.now() - 60_000),
  lastDispatchAt: null,
  state: "ok",
  cron: null,
  delivery: null,
  ...extra,
})

const files = { uploading: 0, ready: 0, failed: 0, readyBytes: 0, unposted: 0 }

describe("the scheduler panel", () => {
  beforeEach(() => {
    heartbeat.getSchedulerHealth.mockResolvedValue(health())
  })

  it("shows whether the scheduler ticks, its last tick, the jobs on and failing, and links to Scheduled jobs", async () => {
    db.scheduledJob.findMany.mockResolvedValue([{ lastStatus: "ok" }, { lastStatus: "error" }, { lastStatus: null }])
    const html = renderToStaticMarkup(await SchedulerPanel())
    const text = textOf(html)
    expect(text).toContain("Ticking")
    expect(text).toMatch(/Last tick 1 minute ago/)
    expect(text).toContain("Jobs 3 on , 1 failing")
    expect(html).toContain('href="/admin/jobs"')
    expect(db.scheduledJob.findMany).toHaveBeenCalledWith({ where: { enabled: true }, select: { lastStatus: true } })
  })

  it("says when it isn't set up, and that every job ships off", async () => {
    heartbeat.getSchedulerHealth.mockResolvedValue(health({ lastTickAt: null, state: "never" }))
    db.scheduledJob.findMany.mockResolvedValue([])
    const text = textOf(renderToStaticMarkup(await SchedulerPanel()))
    expect(text).toContain("Not set up")
    expect(text).toContain("None switched on (every job ships off)")
  })

  it("loads its data when called, so a failure stays inside the page's SafeSlot", async () => {
    heartbeat.getSchedulerHealth.mockRejectedValue(new Error("db down"))
    db.scheduledJob.findMany.mockResolvedValue([])
    await expect(SchedulerPanel()).rejects.toThrow("db down")
  })
})

describe("the storage panel", () => {
  const supabase = (bucket: StorageUsage["bucket"], extra: Partial<StorageUsage> = {}): StorageUsage => ({ kind: "supabase", bucket, files, ...extra })

  it("shows the Supabase bucket against the Free plan's 1 GB, and room files by status", async () => {
    usage.getStorageUsage.mockResolvedValue(
      supabase({ exists: true, public: false, fileSizeLimit: 50_000_000, objects: 1_204, bytes: 810_000_000, otherBytes: 20_000_000 }, { files: { uploading: 1, ready: 42, failed: 2, readyBytes: 310_000_000, unposted: 3 } }),
    )
    const html = renderToStaticMarkup(await StoragePanel())
    const text = textOf(html)
    expect(text).toContain("Supabase Storage")
    expect(text).toContain("830 MB of 1 GB (Free plan) · 83%")
    expect(html).toContain('aria-valuenow="83"')
    expect(html).toContain("bg-tone-warning-foreground")
    expect(text).toContain("Bucket jack 1,204 files, 810 MB · private, 50 MB per file")
    expect(text).toContain("Other buckets 20 MB (counts toward the same 1 GB)")
    expect(text).toContain("42 ready (310 MB) · 1 uploading · 2 failed")
    expect(text).toContain("3 never posted (the files.cleanup job deletes them after 7 days)")
    expect(html).toContain('href="/api/admin/jack/render-check"')
  })

  it("says when the bucket is missing, or its usage can't be read", async () => {
    usage.getStorageUsage.mockResolvedValue(supabase({ exists: false, public: false, fileSizeLimit: null, objects: 0, bytes: 0, otherBytes: 0 }))
    expect(textOf(renderToStaticMarkup(await StoragePanel()))).toContain("The bucket “jack” doesn't exist yet")

    usage.getStorageUsage.mockResolvedValue(supabase(null, { bucketError: "Couldn't read Storage's tables (storage.objects) from the database" }))
    const text = textOf(renderToStaticMarkup(await StoragePanel()))
    expect(text).toContain("Usage Couldn't read Storage's tables (storage.objects) from the database")
    expect(text).toContain("Room files None yet")
  })

  it("names the local folder, Blob or no store, without usage", async () => {
    usage.getStorageUsage.mockResolvedValue({ kind: "files", bucket: null, files })
    const local = textOf(renderToStaticMarkup(await StoragePanel()))
    expect(local).toContain("Local folder")
    expect(local).toContain(".jack-renders/ on this machine")
    expect(local).not.toContain("Free plan")

    usage.getStorageUsage.mockResolvedValue({ kind: "blob", bucket: null, files })
    expect(textOf(renderToStaticMarkup(await StoragePanel()))).toContain("Vercel Blob can't take room uploads")

    usage.getStorageUsage.mockResolvedValue({ kind: "none", bucket: null, files })
    const none = renderToStaticMarkup(await StoragePanel())
    expect(textOf(none)).toContain("No file store is connected")
    expect(none).not.toContain("render-check")
  })

  it("shows no key or project link", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-" + "x".repeat(24))
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co")
    usage.getStorageUsage.mockResolvedValue(supabase({ exists: true, public: false, fileSizeLimit: null, objects: 1, bytes: 1, otherBytes: 0 }))
    const html = renderToStaticMarkup(await StoragePanel())
    expect(html).not.toContain("service-role-")
    expect(html).not.toContain("supabase.co")
  })
})
