import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({
  recruitingCycle: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  recruitingTrackConfig: { findMany: vi.fn(), findUnique: vi.fn(), createMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  application: { groupBy: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }));

vi.mock("@/server/db", () => ({ prisma: db }));
vi.mock("@/server/audit/log", () => audit);

import { FORM_VERSION, tracks } from "@/schemas/recruiting.schema";
import { createCycle, deleteCycle, getTrackConfigs, listCycles, saveTrackConfig, setActiveCycle, updateCycle } from "./recruiting-cycle.service";

const interviewTeam = tracks.find((t) => t.interviewRequired)!;
const noInterviewTeam = tracks.find((t) => !t.interviewRequired)!;
const OFFICER = "officer-1";
const opensAt = new Date("2026-10-01T05:00:00Z");
const closesAt = new Date("2026-10-17T04:59:00Z");
const valid = { name: "Fall 2026", slug: "fall-2026", opensAt, closesAt };

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.recruitingCycle.findFirst.mockResolvedValue(null);
  db.recruitingCycle.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-cycle", createdAt: new Date(), ...data }));
  db.recruitingTrackConfig.findMany.mockResolvedValue([]);
});

describe("createCycle", () => {
  it("creates an inactive round at the current form version and audits it", async () => {
    const created = await createCycle(OFFICER, valid);
    expect(db.recruitingCycle.create).toHaveBeenCalledWith({
      data: { slug: "fall-2026", name: "Fall 2026", opensAt, closesAt, isActive: false, formVersion: FORM_VERSION },
    });
    expect(created.id).toBe("new-cycle");
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: OFFICER, actionType: "RECRUITING_CYCLE_CREATED", entityId: "new-cycle" }),
      db,
    );
  });

  it.each([
    ["a blank name", { name: "   " }, "name"],
    ["an uppercase address", { slug: "Fall-2026" }, "slug"],
    ["an address with spaces", { slug: "fall 2026" }, "slug"],
    ["a one-character address", { slug: "f" }, "slug"],
    ["a closing time before the opening", { closesAt: new Date("2026-09-01T00:00:00Z") }, "closesAt"],
    ["identical open and close times", { closesAt: opensAt }, "closesAt"],
  ])("rejects %s", async (_name, over, field) => {
    await expect(createCycle(OFFICER, { ...valid, ...over })).rejects.toMatchObject({ code: "INVALID", fieldErrors: { [field]: expect.any(String) } });
    expect(db.recruitingCycle.create).not.toHaveBeenCalled();
  });

  it("copies the previous round's booking links, since they are usually reused", async () => {
    db.recruitingCycle.findFirst.mockResolvedValue({ id: "old-cycle" });
    db.recruitingTrackConfig.findMany.mockResolvedValue([{ track: interviewTeam.key, schedulingUrl: "https://calendar.app.google/abc" }]);
    const created = await createCycle(OFFICER, valid);
    expect(db.recruitingTrackConfig.findMany).toHaveBeenCalledWith({ where: { cycleId: "old-cycle", schedulingUrl: { not: null } } });
    expect(db.recruitingTrackConfig.createMany).toHaveBeenCalledWith({
      data: [{ cycleId: "new-cycle", track: interviewTeam.key, schedulingUrl: "https://calendar.app.google/abc", updatedById: OFFICER }],
    });
    expect(created.copiedLinks).toBe(1);
  });

  it("copies nothing when there is no earlier round or it had no links", async () => {
    await createCycle(OFFICER, valid);
    db.recruitingCycle.findFirst.mockResolvedValue({ id: "old-cycle" });
    await createCycle(OFFICER, valid);
    expect(db.recruitingTrackConfig.createMany).not.toHaveBeenCalled();
  });

  it("explains a taken address instead of failing with a database error", async () => {
    db.recruitingCycle.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }));
    await expect(createCycle(OFFICER, valid)).rejects.toMatchObject({ code: "INVALID", fieldErrors: { slug: expect.stringContaining("already used") } });
  });

  it("lets other database errors through", async () => {
    db.recruitingCycle.create.mockRejectedValue(new Error("connection lost"));
    await expect(createCycle(OFFICER, valid)).rejects.toThrow("connection lost");
  });
});

describe("updateCycle", () => {
  const before = { id: "c1", name: "Old name", slug: "fall-2026", opensAt, closesAt };

  it("changes the name and dates but never the address", async () => {
    db.recruitingCycle.findUnique.mockResolvedValue(before);
    db.recruitingCycle.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...before, ...data }));
    const later = new Date("2026-10-20T04:59:00Z");
    await updateCycle(OFFICER, "c1", { name: "Fall 2026 (extended)", opensAt, closesAt: later });
    const data = db.recruitingCycle.update.mock.calls[0][0].data;
    expect(data).toEqual({ name: "Fall 2026 (extended)", opensAt, closesAt: later });
    expect(data).not.toHaveProperty("slug");
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ before: { name: "Old name", opensAt, closesAt }, after: { name: "Fall 2026 (extended)", opensAt, closesAt: later } }),
    );
  });

  it("validates the dates and reports an unknown round", async () => {
    await expect(updateCycle(OFFICER, "c1", { name: "x", opensAt: closesAt, closesAt: opensAt })).rejects.toMatchObject({ code: "INVALID" });
    db.recruitingCycle.findUnique.mockResolvedValue(null);
    await expect(updateCycle(OFFICER, "nope", { name: "x", opensAt, closesAt })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("setActiveCycle", () => {
  beforeEach(() => {
    db.recruitingCycle.findUnique.mockResolvedValue({ id: "c2" });
    db.recruitingCycle.findFirst.mockResolvedValue({ id: "c1", name: "Spring" });
    db.recruitingCycle.updateMany.mockResolvedValue({ count: 1 });
    db.recruitingCycle.update.mockResolvedValue({ id: "c2", name: "Fall" });
  });

  it("switches the old round off BEFORE the new one on (the database allows only one active round)", async () => {
    await setActiveCycle(OFFICER, "c2");
    expect(db.recruitingCycle.updateMany).toHaveBeenCalledWith({ where: { isActive: true }, data: { isActive: false } });
    expect(db.recruitingCycle.update).toHaveBeenCalledWith({ where: { id: "c2" }, data: { isActive: true } });
    expect(db.recruitingCycle.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.recruitingCycle.update.mock.invocationCallOrder[0]);
  });

  it("runs both steps in one transaction and audits who it replaced", async () => {
    await setActiveCycle(OFFICER, "c2");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "RECRUITING_CYCLE_ACTIVATED", before: { activeCycleId: "c1" }, after: { activeCycleId: "c2" } }),
      db,
    );
  });

  it("with null, turns recruiting off and activates nothing", async () => {
    const result = await setActiveCycle(OFFICER, null);
    expect(result).toBeNull();
    expect(db.recruitingCycle.updateMany).toHaveBeenCalledTimes(1);
    expect(db.recruitingCycle.update).not.toHaveBeenCalled();
  });

  it("reports an unknown round without switching the current one off", async () => {
    db.recruitingCycle.findUnique.mockResolvedValue(null);
    await expect(setActiveCycle(OFFICER, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.recruitingCycle.updateMany).not.toHaveBeenCalled();
  });
});

describe("deleteCycle", () => {
  const cycle = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Old", slug: "old", isActive: false, _count: { applications: 0 }, ...over });

  it("deletes an unused, inactive round and audits it", async () => {
    db.recruitingCycle.findUnique.mockResolvedValue(cycle());
    await deleteCycle(OFFICER, "c1");
    expect(db.recruitingCycle.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "RECRUITING_CYCLE_DELETED" }));
  });

  it("keeps the active round", async () => {
    db.recruitingCycle.findUnique.mockResolvedValue(cycle({ isActive: true }));
    await expect(deleteCycle(OFFICER, "c1")).rejects.toMatchObject({ code: "BAD_STATUS" });
    expect(db.recruitingCycle.delete).not.toHaveBeenCalled();
  });

  it("keeps a round that has any application, even a draft", async () => {
    db.recruitingCycle.findUnique.mockResolvedValue(cycle({ _count: { applications: 1 } }));
    await expect(deleteCycle(OFFICER, "c1")).rejects.toMatchObject({ code: "BAD_STATUS" });
    expect(db.recruitingCycle.delete).not.toHaveBeenCalled();
  });

  it("reports an unknown round", async () => {
    db.recruitingCycle.findUnique.mockResolvedValue(null);
    await expect(deleteCycle(OFFICER, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("saveTrackConfig", () => {
  beforeEach(() => {
    db.recruitingCycle.findUnique.mockResolvedValue({ id: "c1", name: "Fall 2026" });
    db.recruitingTrackConfig.findUnique.mockResolvedValue(null);
  });
  const save = (url: string | null, track: string = interviewTeam.key, options?: { allowOtherHost?: boolean }) => saveTrackConfig(OFFICER, "c1", track, url, options);

  it("saves a Google Calendar booking link and audits the change", async () => {
    db.recruitingTrackConfig.findUnique.mockResolvedValue({ schedulingUrl: "https://calendar.app.google/old" });
    await save("  https://calendar.app.google/new  ");
    expect(db.recruitingTrackConfig.upsert).toHaveBeenCalledWith({
      where: { cycleId_track: { cycleId: "c1", track: interviewTeam.key } },
      create: { cycleId: "c1", track: interviewTeam.key, schedulingUrl: "https://calendar.app.google/new", updatedById: OFFICER },
      update: { schedulingUrl: "https://calendar.app.google/new", updatedById: OFFICER },
    });
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ before: { schedulingUrl: "https://calendar.app.google/old" }, after: { schedulingUrl: "https://calendar.app.google/new" } }),
    );
  });

  it("accepts the other Google Calendar host", async () => {
    await save("https://calendar.google.com/calendar/appointments/schedules/abc");
    expect(db.recruitingTrackConfig.upsert).toHaveBeenCalled();
  });

  it("clears the link when the value is blank", async () => {
    await save("   ");
    expect(db.recruitingTrackConfig.deleteMany).toHaveBeenCalledWith({ where: { cycleId: "c1", track: interviewTeam.key } });
    expect(db.recruitingTrackConfig.upsert).not.toHaveBeenCalled();
    await save(null);
    expect(db.recruitingTrackConfig.deleteMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["http", "http://calendar.app.google/abc"],
    ["not a URL", "calendar.app.google/abc"],
    ["javascript", "javascript:alert(1)"],
    ["a link with credentials", "https://user:pw@calendar.app.google/abc"],
    ["a link with a space", "https://calendar.app.google/a bc"],
  ])("rejects %s", async (_name, url) => {
    await expect(save(url, interviewTeam.key, { allowOtherHost: true })).rejects.toMatchObject({ code: "INVALID" });
    expect(db.recruitingTrackConfig.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-Google host unless the officer explicitly allows it", async () => {
    await expect(save("https://calendly.com/lsr/interview")).rejects.toMatchObject({ code: "INVALID", fieldErrors: { schedulingUrl: expect.any(String) } });
    await expect(save("https://calendar.app.google.evil.test/x")).rejects.toMatchObject({ code: "INVALID" });
    await save("https://calendly.com/lsr/interview", interviewTeam.key, { allowOtherHost: true });
    expect(db.recruitingTrackConfig.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses a team that doesn't interview, an unknown team, and an unknown round", async () => {
    await expect(save("https://calendar.app.google/abc", noInterviewTeam.key)).rejects.toMatchObject({ code: "INVALID" });
    await expect(save("https://calendar.app.google/abc", "not-a-team")).rejects.toMatchObject({ code: "INVALID" });
    db.recruitingCycle.findUnique.mockResolvedValue(null);
    await expect(save("https://calendar.app.google/abc")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listCycles and getTrackConfigs", () => {
  it("adds the open/closed state and application counts to each round", async () => {
    db.recruitingCycle.findMany.mockResolvedValue([
      { id: "c1", slug: "fall", opensAt, closesAt },
      { id: "c2", slug: "old", opensAt: new Date("2025-10-01T00:00:00Z"), closesAt: new Date("2025-10-17T00:00:00Z") },
    ]);
    db.application.groupBy.mockResolvedValue([
      { cycleId: "c1", state: "SUBMITTED", _count: { _all: 12 } },
      { cycleId: "c1", state: "DRAFT", _count: { _all: 3 } },
    ]);
    const rounds = await listCycles(new Date("2026-10-10T12:00:00Z"));
    expect(rounds[0]).toMatchObject({ window: "open", submitted: 12, drafts: 3 });
    expect(rounds[1]).toMatchObject({ window: "closed", submitted: 0, drafts: 0 });
  });

  it("returns booking links keyed by team", async () => {
    db.recruitingTrackConfig.findMany.mockResolvedValue([{ track: "a", schedulingUrl: "https://x" }, { track: "b", schedulingUrl: null }]);
    expect(await getTrackConfigs("c1")).toEqual({ a: "https://x", b: null });
  });
});
