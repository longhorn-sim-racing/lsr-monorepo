import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ page: { findUnique: vi.fn() } }))
const pages = vi.hoisted(() => ({ updatePageContent: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/page.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/page.service")>()), updatePageContent: pages.updatePageContent }))

import { LSC_RULES_SLUG } from "@/lib/page-slugs"
import { ProposalInputError, StaleProposalError } from "./errors"
import { pageUpdateKind, pageUpdateSchema } from "./page-update"
import type { ProposalApplyContext, ProposalContext } from "./types"

const BODY = "# Lone Star Cup rules\n\nRaces start at 7 PM.\nPractice starts at 6 PM.\nBring your own wheel."
const rules = { id: "page-1", title: "Lone Star Cup Rules", slug: LSC_RULES_SLUG, bodyMd: BODY, visibility: "public" }
const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit })

beforeEach(() => {
  db.page.findUnique.mockResolvedValue(rules)
})

describe("page.update", () => {
  it("is offered by propose_change to any officer, for pages", () => {
    expect(pageUpdateKind).toMatchObject({ kind: "page.update", tool: "propose_change", permission: "officer", targetType: "PAGE" })
    expect(pageUpdateSchema.safeParse({ pageId: "page-1" }).success).toBe(false)
    expect(pageUpdateSchema.safeParse({ pageId: "page-1", title: "New" }).success).toBe(true)
    expect(pageUpdateSchema.safeParse({ pageId: "page-1", edits: [{ find: "7 PM", replace: "8 PM" }] }).success).toBe(true)
  })

  it("describes an edit as a diff of the text, snapshotting the title and text as they are", async () => {
    const prepared = await pageUpdateKind.prepare({ pageId: "page-1", edits: [{ find: "7 PM", replace: "8 PM" }] }, ctx)
    expect(prepared.before).toEqual({ title: rules.title, bodyMd: BODY })
    expect(prepared.targetId).toBe("page-1")
    expect(prepared.view).toEqual({
      title: "Edit the page “Lone Star Cup Rules”",
      summary: "Applying it changes its text in 1 place. The site shows it at /lone-star-cup/rules.",
      diff: [{ field: "bodyMd", label: "Text", before: BODY, after: BODY.replace("7 PM", "8 PM"), format: "markdown" }],
      links: [
        { title: "Edit page", url: "/admin/pages/page-1" },
        { title: "Public page", url: "/lone-star-cup/rules" },
      ],
    })
  })

  it("describes a rename, and says when a page is a draft", async () => {
    db.page.findUnique.mockResolvedValue({ ...rules, slug: "officer-handbook", visibility: "officers" })
    const prepared = await pageUpdateKind.prepare({ pageId: "page-1", title: "LSC Rules" }, ctx)
    expect(prepared.view.title).toBe("Rename the page “Lone Star Cup Rules”")
    expect(prepared.view.summary).toBe("Applying it renames it “LSC Rules”. It's a draft, so only officers see it.")
    expect(prepared.view.diff).toEqual([{ field: "title", label: "Title", before: rules.title, after: "LSC Rules", format: "text" }])
  })

  it("refuses finds that are missing or ambiguous, a missing page, and changes that change nothing", async () => {
    await expect(pageUpdateKind.prepare({ pageId: "page-1", edits: [{ find: "9 PM", replace: "8 PM" }] }, ctx)).rejects.toThrow(/the find text isn't in the page's text/)
    await expect(pageUpdateKind.prepare({ pageId: "page-1", edits: [{ find: " PM.", replace: " PM sharp." }] }, ctx)).rejects.toThrow(/appears 2 times/)
    await expect(pageUpdateKind.prepare({ pageId: "page-1", title: rules.title }, ctx)).rejects.toThrow(/Nothing would change/)
    db.page.findUnique.mockResolvedValue(null)
    await expect(pageUpdateKind.prepare({ pageId: "nope", title: "X" }, ctx)).rejects.toBeInstanceOf(ProposalInputError)
  })

  it("is all or none: one bad edit and nothing is proposed", async () => {
    await expect(pageUpdateKind.prepare({ pageId: "page-1", edits: [{ find: "7 PM", replace: "8 PM" }, { find: "nope", replace: "x" }] }, ctx)).rejects.toThrow(/^Edit 2:/)
  })

  it("is stale when the title or the text changed, or the page is gone", async () => {
    const before = { title: rules.title, bodyMd: BODY }
    const p = { pageId: "page-1", edits: [{ find: "7 PM", replace: "8 PM" }] }
    expect(await pageUpdateKind.checkStale(p, before)).toBeNull()
    db.page.findUnique.mockResolvedValue({ ...rules, title: "Rules (old)" })
    expect(await pageUpdateKind.checkStale(p, before)).toBe("The page's title changed since this was proposed (it's now “Rules (old)”).")
    db.page.findUnique.mockResolvedValue({ ...rules, bodyMd: `${BODY}\nNew rule.` })
    expect(await pageUpdateKind.checkStale(p, before)).toBe("Someone edited the page's text since this was proposed.")
    db.page.findUnique.mockResolvedValue(null)
    expect(await pageUpdateKind.checkStale(p, before)).toBe("The page was deleted.")
  })

  it("applies through the page service, only if the page is still as proposed", async () => {
    const before = { title: rules.title, bodyMd: BODY }
    pages.updatePageContent.mockResolvedValue({ ok: true, page: { ...rules, title: "LSC Rules" }, before: rules })
    const result = await pageUpdateKind.apply({ pageId: "page-1", title: "LSC Rules", edits: [{ find: "7 PM", replace: "8 PM" }] }, applyCtx(before))
    expect(pages.updatePageContent).toHaveBeenCalledWith("page-1", { title: "LSC Rules", bodyMd: BODY.replace("7 PM", "8 PM") }, { actorUserId: "u2", expected: before, auditMetadata: audit })
    expect(result).toEqual({
      summary: "Updated the page “LSC Rules”.",
      links: [
        { title: "LSC Rules", url: "/admin/pages/page-1" },
        { title: "Public page", url: "/lone-star-cup/rules" },
      ],
    })
  })

  it("goes stale when the page changed between the check and the write", async () => {
    const before = { title: rules.title, bodyMd: BODY }
    const p = { pageId: "page-1", edits: [{ find: "7 PM", replace: "8 PM" }] }
    pages.updatePageContent.mockResolvedValue({ ok: false, error: "The page changed since this was proposed.", reason: "changed" })
    await expect(pageUpdateKind.apply(p, applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
    pages.updatePageContent.mockResolvedValue({ ok: false, error: "Page not found.", reason: "not_found" })
    await expect(pageUpdateKind.apply(p, applyCtx(before))).rejects.toThrow("The page was deleted.")
    pages.updatePageContent.mockResolvedValue({ ok: false, error: "Database is down", reason: "error" })
    await expect(pageUpdateKind.apply(p, applyCtx(before))).rejects.toThrow("Database is down")
    await expect(pageUpdateKind.apply(p, applyCtx(null))).rejects.toBeInstanceOf(StaleProposalError)
  })
})
