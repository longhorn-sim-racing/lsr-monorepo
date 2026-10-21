import { beforeEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => ({ requireUser: vi.fn() }));
const recruiting = vi.hoisted(() => ({ saveDraft: vi.fn(), setSelectedTracks: vi.fn() }));
const email = vi.hoisted(() => ({ submitAndNotify: vi.fn() }));
const gate = vi.hoisted(() => ({ getApplyAvailability: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/auth/guards", () => guards);
vi.mock("next/cache", () => cache);
vi.mock("@/server/services/recruiting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/recruiting.service")>()), ...recruiting }));
vi.mock("@/server/services/recruiting-email.service", () => email);
vi.mock("@/server/services/recruiting-apply.service", () => gate);

import { RecruitingError } from "@/server/services/recruiting.service";
import { saveProgressAction, setTeamsAction, submitApplicationAction } from "./actions";

const round = { id: "r1", name: "Fall 2026", slug: "fall-2026", opensAt: new Date(), closesAt: new Date() };

beforeEach(() => {
  guards.requireUser.mockResolvedValue({ id: "applicant-1" });
  gate.getApplyAvailability.mockResolvedValue({ state: "open", round });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const allServices = () => [...Object.values(recruiting), ...Object.values(email)];

describe("access", () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["saveProgressAction", () => saveProgressAction("r1", { step: "about" })],
    ["setTeamsAction", () => setTeamsAction("r1", ["media"])],
    ["submitApplicationAction", () => submitApplicationAction("r1")],
  ];

  it.each(calls)("%s does nothing for someone who isn't signed in", async (_name, call) => {
    guards.requireUser.mockRejectedValue(new Error("NotAuthenticated"));
    expect(await call()).toEqual({ ok: false, error: "Sign in to continue.", code: "UNAUTHENTICATED" });
    for (const fn of allServices()) expect(fn).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(calls)("%s does nothing while applications are switched off or there is no round", async (_name, call) => {
    for (const state of [{ state: "off" }, { state: "no-round" }]) {
      gate.getApplyAvailability.mockResolvedValue(state);
      expect(await call()).toEqual({ ok: false, error: "Applications aren't open right now.", code: "CLOSED" });
    }
    for (const fn of allServices()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(calls)("%s still reaches the service before the round opens or after it closes, which enforces its own window", async (_name, call) => {
    for (const state of ["upcoming", "closed"]) {
      gate.getApplyAvailability.mockResolvedValue({ state, round });
      recruiting.saveDraft.mockResolvedValue({});
      recruiting.setSelectedTracks.mockResolvedValue({ added: [], removed: [] });
      email.submitAndNotify.mockResolvedValue({ delivery: null });
      expect((await call()) as { ok: boolean }).toMatchObject({ ok: true });
    }
  });
});

describe("a page left open for an earlier round", () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["saveProgressAction", () => saveProgressAction("old-round", { step: "about" })],
    ["setTeamsAction", () => setTeamsAction("old-round", ["media"])],
    ["submitApplicationAction", () => submitApplicationAction("old-round")],
  ];

  it.each(calls)("%s is refused once another round is the active one, writing nothing", async (_name, call) => {
    expect(await call()).toMatchObject({ ok: false, code: "ROUND_CHANGED" });
    for (const fn of allServices()) expect(fn).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("saving progress", () => {
  it("always uses the signed-in applicant's id, never anything from the request", async () => {
    recruiting.saveDraft.mockResolvedValue({});
    const result = await saveProgressAction("r1", { step: "general", genericAnswers: {}, userId: "someone-else" });
    expect(result.ok).toBe(true);
    expect(recruiting.saveDraft).toHaveBeenCalledWith("applicant-1", { step: "general", genericAnswers: {}, userId: "someone-else" }, expect.any(Date), "r1");
    // the service (not the action) rejects the stray field: it is passed through untouched to be validated there
  });

  it("returns when it was saved, without re-rendering the apply pages (autosave runs often)", async () => {
    recruiting.saveDraft.mockResolvedValue({});
    const result = await saveProgressAction("r1", { step: "about" });
    expect(result).toMatchObject({ ok: true, data: { savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("turns a validation problem into messages the form can show next to the right field", async () => {
    recruiting.saveDraft.mockRejectedValue(new RecruitingError("INVALID", "Some answers need attention.", { fieldErrors: { "genericAnswers.why_join": "Keep it under 1500 characters." } }));
    expect(await saveProgressAction("r1", { step: "general" })).toEqual({
      ok: false,
      error: "Some answers need attention.",
      fieldErrors: { "genericAnswers.why_join": "Keep it under 1500 characters." },
      code: "INVALID",
      report: undefined,
    });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["ROUND_CLOSED", "Applications for this round are closed."],
    ["ROUND_NOT_OPEN_YET", "Applications for this round have not opened yet."],
    ["ALREADY_SUBMITTED", "This application has been submitted and can no longer be changed."],
  ] as const)("passes %s through so the page can explain it", async (code, message) => {
    recruiting.saveDraft.mockRejectedValue(new RecruitingError(code, message));
    expect(await saveProgressAction("r1", { step: "about" })).toMatchObject({ ok: false, error: message, code });
  });

  it("never leaks an unexpected error's details in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    recruiting.saveDraft.mockRejectedValue(new Error("connection to 10.0.0.5 refused"));
    const result = await saveProgressAction("r1", { step: "about" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });
});

describe("choosing teams", () => {
  it("passes the list to the service for the signed-in applicant and reports what changed", async () => {
    recruiting.setSelectedTracks.mockResolvedValue({ added: ["media"], removed: ["technology"], application: { secret: "not returned" } });
    const result = await setTeamsAction("r1", ["media"]);
    expect(recruiting.setSelectedTracks).toHaveBeenCalledWith("applicant-1", ["media"], expect.any(Date), "r1");
    expect(result).toEqual({ ok: true, data: { added: ["media"], removed: ["technology"] } });
  });

  it("explains an unknown team", async () => {
    recruiting.setSelectedTracks.mockRejectedValue(new RecruitingError("INVALID", "Choose teams from the list.", { fieldErrors: { tracks: "Unknown team: x" } }));
    expect(await setTeamsAction("r1", ["x"])).toMatchObject({ ok: false, fieldErrors: { tracks: "Unknown team: x" } });
  });
});

describe("submitting", () => {
  it("submits for the signed-in applicant and says whether the confirmation email went out", async () => {
    email.submitAndNotify.mockResolvedValue({ applicationId: "a1", delivery: { emailId: "e1", status: "SENT" } });
    expect(await submitApplicationAction("r1")).toEqual({ ok: true, data: { emailStatus: "SENT" } });
    expect(email.submitAndNotify).toHaveBeenCalledWith("applicant-1", expect.any(Date), "r1");
  });

  it("still succeeds when the confirmation email failed (the submission is what matters)", async () => {
    email.submitAndNotify.mockResolvedValue({ applicationId: "a1", delivery: { emailId: "e1", status: "FAILED", error: "disabled" } });
    expect(await submitApplicationAction("r1")).toEqual({ ok: true, data: { emailStatus: "FAILED" } });
    email.submitAndNotify.mockResolvedValue({ applicationId: "a1", delivery: null });
    expect(await submitApplicationAction("r1")).toEqual({ ok: true, data: { emailStatus: null } });
  });

  it("returns the completeness report when the application isn't finished, so the page can show what's missing", async () => {
    const report = { complete: false, sections: [{ key: "general", label: "General questions", complete: false, problems: ["Missing: Why do you want to join?"] }] };
    email.submitAndNotify.mockRejectedValue(new RecruitingError("INCOMPLETE", "Your application is not complete yet.", { report }));
    const result = await submitApplicationAction("r1");
    expect(result).toMatchObject({ ok: false, code: "INCOMPLETE", report });
  });

  it("refuses a second submit with a clear message", async () => {
    email.submitAndNotify.mockRejectedValue(new RecruitingError("ALREADY_SUBMITTED", "This application has already been submitted."));
    expect(await submitApplicationAction("r1")).toMatchObject({ ok: false, code: "ALREADY_SUBMITTED" });
  });
});
