import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({
  page: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }));
vi.mock("@/server/db", () => ({ prisma: db }));
vi.mock("@/server/audit/log", () => audit);
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);

import { savePage } from "@/app/admin/pages/actions";
import { LSC_RULES_SLUG } from "@/lib/page-slugs";
import { createPage, updatePageContent } from "./page.service";

const page = (extra: Partial<Record<string, unknown>> = {}) => ({
  id: "p1",
  title: "Lone Star Cup Rules",
  slug: LSC_RULES_SLUG,
  bodyMd: "# Rules",
  visibility: "public",
  authorId: "u0",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  ...extra,
});
const input = { title: "Lone Star Cup Rules", slug: LSC_RULES_SLUG, visibility: "public" as const, bodyMd: "# Rules v2" };

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" });
  db.page.findUnique.mockResolvedValue(page());
  db.page.update.mockImplementation(async ({ data }) => page(data));
  db.page.create.mockImplementation(async ({ data }) => page({ id: "p2", ...data }));
});

describe("savePage (the admin form), through the page service", () => {
  it("updates a page, audits it with before and after, and refreshes the pages that show it", async () => {
    expect(await savePage("p1", input)).toEqual({ ok: true, id: "p1" });
    expect(db.page.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { ...input, authorId: "officer-1" } });
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "PAGE",
      entityId: "p1",
      summary: "Updated page: Lone Star Cup Rules",
      before: page(),
      after: page({ ...input, authorId: "officer-1" }),
    });
    expect(cache.revalidatePath.mock.calls.map(([path]) => path)).toEqual(["/admin/pages", "/lone-star-cup", "/lone-star-cup/rules"]);
  });

  it("says when a page was published or unpublished", async () => {
    db.page.findUnique.mockResolvedValue(page({ slug: "about", visibility: "officers" }));
    await savePage("p1", { ...input, slug: "about" });
    expect(audit.createAuditLog.mock.calls[0][0].summary).toBe("Updated page: Lone Star Cup Rules (published)");
  });

  it("creates a page", async () => {
    expect(await savePage(null, { ...input, slug: "new-page" })).toEqual({ ok: true, id: "p2" });
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actionType: "CREATE", entityId: "p2", summary: "Created page: Lone Star Cup Rules", before: undefined });
  });

  it("keeps the LSC rules slug", async () => {
    expect(await savePage("p1", { ...input, slug: "rules" })).toEqual({ ok: false, error: `The slug "${LSC_RULES_SLUG}" is used by the site and can't be changed.` });
    expect(db.page.update).not.toHaveBeenCalled();
  });

  it("reports a missing page, a taken slug and a signed-out officer as before", async () => {
    db.page.findUnique.mockResolvedValue(null);
    expect(await savePage("nope", input)).toEqual({ ok: false, error: "Page not found." });

    db.page.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "test" }));
    expect(await savePage(null, { ...input, slug: "taken" })).toEqual({ ok: false, error: "Another page already uses that slug." });

    guards.requireOfficer.mockRejectedValue(new Error("Not signed in"));
    expect(await savePage("p1", input)).toEqual({ ok: false, error: "You're signed out or no longer an officer. Copy your text, sign in again, and retry." });
  });

  it("checks the form first", async () => {
    expect(await savePage("p1", { ...input, title: "  " })).toEqual({ ok: false, error: "Give the page a title." });
    expect(await savePage("p1", { ...input, slug: "Bad Slug" })).toEqual({ ok: false, error: "Slug: lowercase letters, numbers and dashes." });
  });
});

describe("updatePageContent with expected (Jack's proposals)", () => {
  const expected = { title: "Lone Star Cup Rules", bodyMd: "# Rules" };

  it("saves only if the page still matches, in one conditional update, and tags the audit entry", async () => {
    db.page.updateMany.mockResolvedValue({ count: 1 });
    db.page.findUniqueOrThrow.mockResolvedValue(page({ bodyMd: "# Rules v2", authorId: "officer-2" }));
    const metadata = { via: "jack", proposalId: "prop-1", roomId: "room-1", proposedFor: "officer-1" };
    const saved = await updatePageContent("p1", { bodyMd: "# Rules v2" }, { actorUserId: "officer-2", expected, auditMetadata: metadata });
    expect(saved).toMatchObject({ ok: true, page: { bodyMd: "# Rules v2" } });
    expect(db.page.updateMany).toHaveBeenCalledWith({ where: { id: "p1", ...expected }, data: { bodyMd: "# Rules v2", authorId: "officer-2" } });
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "officer-2", entityType: "PAGE", metadata });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/lone-star-cup/rules");
  });

  it("reports 'changed' when someone saved in between, and writes nothing else", async () => {
    db.page.updateMany.mockResolvedValue({ count: 0 });
    expect(await updatePageContent("p1", { bodyMd: "# Rules v2" }, { actorUserId: "officer-2", expected })).toEqual({
      ok: false,
      error: "The page changed since this was proposed.",
      reason: "changed",
    });
    expect(audit.createAuditLog).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("checks partial changes too", async () => {
    expect(await updatePageContent("p1", { bodyMd: "x".repeat(50_001) }, { actorUserId: "o" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await createPage({ ...input, title: "" }, { actorUserId: "o" })).toMatchObject({ ok: false, reason: "invalid" });
  });
});
