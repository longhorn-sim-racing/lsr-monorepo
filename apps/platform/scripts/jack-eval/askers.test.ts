import { describe, expect, it, vi } from "vitest";
import { describeAsker, firstOfficer, paired, resolveAsker } from "./askers";
import type { EvalContext, Question } from "./shared";

const DYLAN = { id: "u-dylan", displayName: "Dylan", handle: "dylan" };

function fakeUsers(found: typeof DYLAN | null = DYLAN) {
  const findFirst = vi.fn(async () => found);
  return { findFirst, prisma: { user: { findFirst } } as unknown as EvalContext["prisma"] };
}

const OFFICER_ONLY = { status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } };

describe("resolveAsker", () => {
  it("finds an officer by handle (with or without @), email or id, never anyone else", async () => {
    const { prisma, findFirst } = fakeUsers();
    expect(await resolveAsker(prisma, "@Dylan")).toEqual(DYLAN);
    expect(findFirst).toHaveBeenLastCalledWith({ where: { ...OFFICER_ONLY, OR: [{ handle: "dylan" }, { id: "Dylan" }] }, select: { id: true, displayName: true, handle: true } });
    await resolveAsker(prisma, "Dylan@UTexas.edu");
    expect(findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ...OFFICER_ONLY, email: "dylan@utexas.edu" } }));
  });

  it("takes the first officer in a department, by account age", async () => {
    const { prisma, findFirst } = fakeUsers();
    await resolveAsker(prisma, { department: "media" });
    expect(findFirst).toHaveBeenLastCalledWith({ where: { ...OFFICER_ONLY, department: "media" }, orderBy: { createdAt: "asc" }, select: { id: true, displayName: true, handle: true } });
  });

  it("runs a lookup, and gives null when there's nobody to ask as", async () => {
    const { prisma, findFirst } = fakeUsers();
    const lookup = vi.fn(async () => "dylan");
    expect(await resolveAsker(prisma, lookup)).toEqual(DYLAN);
    expect(lookup).toHaveBeenCalledWith(prisma);
    expect(await resolveAsker(prisma, async () => null)).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(await resolveAsker(fakeUsers(null).prisma, "nobody")).toBeNull();
  });
});

describe("firstOfficer", () => {
  it("takes the oldest officer or admin account that isn't deleted", async () => {
    const { prisma, findFirst } = fakeUsers();
    expect(await firstOfficer(prisma)).toEqual(DYLAN);
    expect(findFirst).toHaveBeenLastCalledWith({ where: OFFICER_ONLY, orderBy: { createdAt: "asc" }, select: { id: true, displayName: true, handle: true } });
  });
});

describe("describeAsker", () => {
  it("says who a question wanted, for its skip note", () => {
    expect(describeAsker("dylan")).toBe("@dylan");
    expect(describeAsker("@dylan")).toBe("@dylan");
    expect(describeAsker("dylan@utexas.edu")).toBe("dylan@utexas.edu");
    expect(describeAsker({ department: "media" })).toBe("the first media officer");
    expect(describeAsker(async () => null)).toBe("the officer its lookup names");
  });
});

describe("paired", () => {
  const base: Omit<Question, "as" | "pair"> = { id: "paired-lsc", ask: "How's the LSC going?", truth: async () => null };

  it("asks the same question as each officer, under one pair", () => {
    const [a, b] = paired(base, [
      { label: "competition", as: { department: "competition" } },
      { label: "media", as: "@arav" },
    ]);
    expect(a).toMatchObject({ id: "paired-lsc@competition", pair: "paired-lsc", as: { department: "competition" }, ask: base.ask });
    expect(b).toMatchObject({ id: "paired-lsc@media", pair: "paired-lsc", as: "@arav" });
  });

  it("needs two askers with distinct, plain labels", () => {
    expect(() => paired(base, [{ label: "media", as: "a" }])).toThrow("at least two askers");
    expect(() => paired(base, [{ label: "media", as: "a" }, { label: "media", as: "b" }])).toThrow("distinct");
    expect(() => paired(base, [{ label: "Media Team", as: "a" }, { label: "tech", as: "b" }])).toThrow("lowercase");
  });
});
