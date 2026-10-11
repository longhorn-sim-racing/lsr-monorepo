import { beforeEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }));
const recruiting = vi.hoisted(() => ({ addReview: vi.fn() }));
const email = vi.hoisted(() => ({ bulkDecide: vi.fn(), decideAndNotify: vi.fn(), previewDecisionEmail: vi.fn(), resendAllFailed: vi.fn(), resendEmail: vi.fn() }));
const cycles = vi.hoisted(() => ({ createCycle: vi.fn(), deleteCycle: vi.fn(), saveTrackConfig: vi.fn(), setActiveCycle: vi.fn(), updateCycle: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/auth/guards", () => guards);
vi.mock("next/cache", () => cache);
vi.mock("@/server/services/recruiting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/recruiting.service")>()), ...recruiting }));
vi.mock("@/server/services/recruiting-email.service", () => email);
vi.mock("@/server/services/recruiting-cycle.service", () => cycles);

import { RecruitingError } from "@/server/services/recruiting.service";
import {
  addReviewAction,
  bulkDecideAction,
  createCycleAction,
  decideAction,
  deleteCycleAction,
  previewDecisionAction,
  resendAllFailedAction,
  resendEmailAction,
  saveBookingLinkAction,
  setActiveCycleAction,
  updateCycleAction,
} from "./actions";

const everyService = [...Object.values(recruiting), ...Object.values(email), ...Object.values(cycles)];

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("access", () => {
  const everyAction: Array<[string, () => Promise<unknown>]> = [
    ["previewDecisionAction", () => previewDecisionAction("t1", "ACCEPTED")],
    ["decideAction", () => decideAction("t1", "ACCEPTED", { sendEmail: true })],
    ["bulkDecideAction", () => bulkDecideAction(["t1"], "ACCEPTED", { sendEmail: true })],
    ["addReviewAction", () => addReviewAction("t1", { score: 3 })],
    ["resendEmailAction", () => resendEmailAction("e1")],
    ["resendAllFailedAction", () => resendAllFailedAction("c1")],
    ["createCycleAction", () => createCycleAction({ name: "Fall", slug: "fall", opensAt: "2026-10-01T00:00", closesAt: "2026-10-16T23:59" })],
    ["updateCycleAction", () => updateCycleAction("c1", { name: "Fall", opensAt: "2026-10-01T00:00", closesAt: "2026-10-16T23:59" })],
    ["setActiveCycleAction", () => setActiveCycleAction("c1")],
    ["deleteCycleAction", () => deleteCycleAction("c1")],
    ["saveBookingLinkAction", () => saveBookingLinkAction("c1", "team", "https://calendar.app.google/x")],
  ];

  it.each(everyAction)("%s does nothing for someone who isn't an officer", async (_name, call) => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"));
    const result = await call();
    expect(result).toEqual({ ok: false, error: "You don't have permission to do that." });
    for (const fn of everyService) expect(fn).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("decisions and email", () => {
  it("passes the officer's id (never one from the client) and returns the service's data", async () => {
    email.decideAndNotify.mockResolvedValue({ status: "ACCEPTED", emailId: "e1", delivery: { emailId: "e1", status: "SENT" } });
    const result = await decideAction("t1", "ACCEPTED", { sendEmail: true, override: { subject: "Hi", body: "Edited" } });
    expect(result).toEqual({ ok: true, data: { status: "ACCEPTED", emailId: "e1", delivery: { emailId: "e1", status: "SENT" } } });
    expect(email.decideAndNotify).toHaveBeenCalledWith("officer-1", "t1", "ACCEPTED", { sendEmail: true, override: { subject: "Hi", body: "Edited" } });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/recruiting", "layout");
  });

  it.each([
    ["a status that doesn't exist", "WAITLISTED"],
    ["the starting status", "SUBMITTED"],
    ["a lowercase status", "accepted"],
    ["an empty status", ""],
  ])("rejects %s before touching the service", async (_name, status) => {
    const result = await decideAction("t1", status, { sendEmail: true });
    expect(result.ok).toBe(false);
    expect(email.decideAndNotify).not.toHaveBeenCalled();
  });

  it("rejects bad ids and a malformed edit", async () => {
    expect((await decideAction("", "ACCEPTED")).ok).toBe(false);
    expect((await decideAction("t".repeat(65), "ACCEPTED")).ok).toBe(false);
    expect((await decideAction("t1", "ACCEPTED", { override: { subject: "s", body: "b", extra: "x" } as never })).ok).toBe(false);
    expect((await decideAction("t1", "ACCEPTED", { sendEmail: "yes" as never })).ok).toBe(false);
    expect(email.decideAndNotify).not.toHaveBeenCalled();
  });

  it("turns a rule from the service into a message the form can show, with its field errors", async () => {
    email.decideAndNotify.mockRejectedValue(new RecruitingError("MISSING_SCHEDULING_LINK", "This team has no booking link yet.", { fieldErrors: { body: "No value for {{schedulingLink}}" } }));
    const result = await decideAction("t1", "INTERVIEW", { sendEmail: true });
    expect(result).toEqual({ ok: false, error: "This team has no booking link yet.", fieldErrors: { body: "No value for {{schedulingLink}}" }, code: "MISSING_SCHEDULING_LINK" });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("never leaks an unexpected error's details in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    email.decideAndNotify.mockRejectedValue(new Error("connection to 10.0.0.5 refused"));
    const result = await decideAction("t1", "ACCEPTED");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });

  it("previews without a send flag and passes the edit through", async () => {
    email.previewDecisionEmail.mockResolvedValue({ subject: "S", body: "B" });
    const result = await previewDecisionAction("t1", "ACCEPTED", { subject: "Custom", body: "Text" });
    expect(result).toEqual({ ok: true, data: { subject: "S", body: "B" } });
    expect(email.previewDecisionEmail).toHaveBeenCalledWith("t1", "ACCEPTED", { subject: "Custom", body: "Text" });
  });

  it("bulk: passes the ids, status and flags, and refuses a non-boolean flag", async () => {
    email.bulkDecide.mockResolvedValue({ total: 2, decided: 2, emailsSent: 2, emailsFailed: 0, failures: [] });
    await bulkDecideAction(["t1", "t2"], "REJECTED", { sendEmail: true, ignoreLimit: false });
    expect(email.bulkDecide).toHaveBeenCalledWith("officer-1", ["t1", "t2"], "REJECTED", { sendEmail: true, ignoreLimit: false });
    expect((await bulkDecideAction(["t1"], "REJECTED", { ignoreLimit: "true" as never })).ok).toBe(false);
  });

  it("bulk: shows the daily-limit message to the officer", async () => {
    email.bulkDecide.mockRejectedValue(new RecruitingError("EMAIL_LIMIT", "This would send 30 emails, but only 10 of today's 100 are left."));
    expect(await bulkDecideAction(["t1"], "ACCEPTED", { sendEmail: true })).toEqual({ ok: false, error: "This would send 30 emails, but only 10 of today's 100 are left.", code: "EMAIL_LIMIT" });
  });

  it("reviews: forwards the officer's id and returns only the new id", async () => {
    recruiting.addReview.mockResolvedValue({ id: "r1", notes: "private", reviewerId: "officer-1" });
    expect(await addReviewAction("t1", { score: 4, notes: "good" })).toEqual({ ok: true, data: { id: "r1" } });
    expect(recruiting.addReview).toHaveBeenCalledWith("officer-1", "t1", { score: 4, notes: "good" });
  });

  it("resend: single and all", async () => {
    email.resendEmail.mockResolvedValue({ emailId: "e1", status: "SENT" });
    expect(await resendEmailAction("e1")).toEqual({ ok: true, data: { emailId: "e1", status: "SENT" } });
    expect(email.resendEmail).toHaveBeenCalledWith("officer-1", "e1");
    email.resendAllFailed.mockResolvedValue({ total: 3, sent: 3, failed: 0 });
    await resendAllFailedAction("c1", { ignoreLimit: true });
    expect(email.resendAllFailed).toHaveBeenCalledWith("officer-1", "c1", { ignoreLimit: true });
  });
});

describe("rounds", () => {
  it("reads datetime-local values as Central time and stores UTC (summer: CDT, winter: CST)", async () => {
    cycles.createCycle.mockResolvedValue({ id: "c1", slug: "fall-2026", copiedLinks: 2 });
    const result = await createCycleAction({ name: "Fall 2026", slug: "fall-2026", opensAt: "2026-10-01T00:00", closesAt: "2026-10-16T23:59" });
    expect(result).toEqual({ ok: true, data: { id: "c1", slug: "fall-2026", copiedLinks: 2 } });
    expect(cycles.createCycle).toHaveBeenCalledWith("officer-1", {
      name: "Fall 2026",
      slug: "fall-2026",
      opensAt: new Date("2026-10-01T05:00:00Z"),
      closesAt: new Date("2026-10-17T04:59:00Z"),
    });
    await createCycleAction({ name: "Winter", slug: "winter", opensAt: "2026-12-01T00:00", closesAt: "2026-12-31T23:59" });
    expect(cycles.createCycle).toHaveBeenLastCalledWith("officer-1", expect.objectContaining({ closesAt: new Date("2027-01-01T05:59:00Z") }));
  });

  it.each([
    ["an empty date", ""],
    ["a date without a time", "2026-10-16"],
    ["a date with seconds", "2026-10-16T23:59:00"],
    ["nonsense", "next friday"],
    ["an impossible month", "2026-13-40T99:99"],
  ])("rejects %s and names the field", async (_name, value) => {
    const result = await createCycleAction({ name: "Fall", slug: "fall", opensAt: "2026-10-01T00:00", closesAt: value });
    expect(result).toMatchObject({ ok: false, fieldErrors: { closesAt: expect.any(String) } });
    expect(cycles.createCycle).not.toHaveBeenCalled();
  });

  it("update never accepts a new address", async () => {
    await updateCycleAction("c1", { name: "Renamed", opensAt: "2026-10-01T00:00", closesAt: "2026-10-16T23:59", slug: "hijack" } as never);
    expect(cycles.updateCycle).toHaveBeenCalledWith("officer-1", "c1", { name: "Renamed", opensAt: expect.any(Date), closesAt: expect.any(Date) });
  });

  it("activates, switches off with null, and deletes", async () => {
    expect(await setActiveCycleAction("c1")).toEqual({ ok: true, data: undefined });
    expect(cycles.setActiveCycle).toHaveBeenLastCalledWith("officer-1", "c1");
    await setActiveCycleAction(null);
    expect(cycles.setActiveCycle).toHaveBeenLastCalledWith("officer-1", null);
    expect((await setActiveCycleAction("")).ok).toBe(false);
    await deleteCycleAction("c1");
    expect(cycles.deleteCycle).toHaveBeenCalledWith("officer-1", "c1");
  });

  it("saves a booking link, passing the 'use another host' choice", async () => {
    await saveBookingLinkAction("c1", "team-a", "https://calendar.app.google/x");
    expect(cycles.saveTrackConfig).toHaveBeenLastCalledWith("officer-1", "c1", "team-a", "https://calendar.app.google/x", { allowOtherHost: false });
    await saveBookingLinkAction("c1", "team-a", "https://calendly.com/x", true);
    expect(cycles.saveTrackConfig).toHaveBeenLastCalledWith("officer-1", "c1", "team-a", "https://calendly.com/x", { allowOtherHost: true });
    expect((await saveBookingLinkAction("c1", "team-a", "x".repeat(2200))).ok).toBe(false);
  });

  it("shows a taken address on the right field", async () => {
    cycles.createCycle.mockRejectedValue(new RecruitingError("INVALID", "A round with that address already exists.", { fieldErrors: { slug: "That address is already used by another round." } }));
    expect(await createCycleAction({ name: "Fall", slug: "fall", opensAt: "2026-10-01T00:00", closesAt: "2026-10-16T23:59" })).toMatchObject({ ok: false, fieldErrors: { slug: expect.any(String) } });
  });
});
