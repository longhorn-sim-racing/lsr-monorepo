import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
const session = vi.hoisted(() => ({ getCachedSessionUser: vi.fn() }));
const availability = vi.hoisted(() => ({ getApplyAvailability: vi.fn() }));
const recruiting = vi.hoisted(() => ({ getOrCreateDraft: vi.fn(), getApplicantStatus: vi.fn() }));

vi.mock("next/navigation", () => nav);
vi.mock("@/server/auth/cached-session", () => session);
vi.mock("@/server/services/recruiting-apply.service", () => availability);
vi.mock("@/server/services/recruiting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/recruiting.service")>()), ...recruiting }));

import { RecruitingError } from "@/server/services/recruiting.service";
import StartPage from "./page";

const round = { id: "r1", name: "Fall 2026", slug: "fall-2026", opensAt: new Date("2026-10-01"), closesAt: new Date("2026-12-31") };

beforeEach(() => {
  vi.clearAllMocks();
  availability.getApplyAvailability.mockResolvedValue({ state: "open", round });
  session.getCachedSessionUser.mockResolvedValue({ user: { id: "u1", email: "ada@account.test" }, roles: [] });
});

describe("/apply/start", () => {
  it("shows the reason instead of crashing when starting is refused (e.g. the account isn't verified)", async () => {
    recruiting.getOrCreateDraft.mockRejectedValue(new RecruitingError("FORBIDDEN", "Finish verifying your account before applying."));
    const page = await StartPage();
    expect(JSON.stringify(page)).toContain("Finish verifying your account before applying.");
    expect(recruiting.getApplicantStatus).not.toHaveBeenCalled();
  });

  it("sends a closed or not-yet-open round back to the landing page rather than crashing", async () => {
    recruiting.getOrCreateDraft.mockRejectedValue(new RecruitingError("ROUND_CLOSED", "Applications for this round are closed."));
    await expect(StartPage()).rejects.toThrow("REDIRECT:/apply");
  });

  it("lets an unexpected error through (it is a real failure, not something to hide)", async () => {
    recruiting.getOrCreateDraft.mockRejectedValue(new Error("database is down"));
    await expect(StartPage()).rejects.toThrow("database is down");
  });

  it("sends a signed-out visitor to sign in and then back here", async () => {
    session.getCachedSessionUser.mockResolvedValue({ user: null, roles: [] });
    await expect(StartPage()).rejects.toThrow("REDIRECT:/auth/signin?next=/apply/start");
    expect(recruiting.getOrCreateDraft).not.toHaveBeenCalled();
  });

  it("sends someone who already submitted to their status page", async () => {
    recruiting.getOrCreateDraft.mockResolvedValue({});
    recruiting.getApplicantStatus.mockResolvedValue({ round, application: { state: "SUBMITTED" } });
    await expect(StartPage()).rejects.toThrow("REDIRECT:/apply/status");
  });

  it("is a 404 while applications are switched off", async () => {
    availability.getApplyAvailability.mockResolvedValue({ state: "off" });
    await expect(StartPage()).rejects.toThrow("NOT_FOUND");
  });
});
