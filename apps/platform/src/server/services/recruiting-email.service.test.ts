import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-ins for Prisma, Resend and the audit log: no database, no network.
const db = vi.hoisted(() => ({
  applicationEmail: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  applicationTrack: { findUnique: vi.fn(), update: vi.fn() },
  recruitingTrackConfig: { findUnique: vi.fn() },
  application: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }));

vi.mock("@/server/db", () => ({ prisma: db }));
vi.mock("@/lib/email/resend", () => mail);
vi.mock("@/server/audit/log", () => audit);

import { tracks } from "@/schemas/recruiting.schema";
import {
  INTERRUPTED_ERROR,
  composeTrackEmail,
  decideAndNotify,
  deliverEmail,
  deliverEmailSafely,
  failInterruptedEmails,
  previewDecisionEmail,
  receivedEmailHook,
  resendEmail,
  statusToTemplate,
} from "./recruiting-email.service";

// Use whatever teams ship, so these tests don't break when the placeholder teams are replaced
const interviewTeam = tracks.find((t) => t.interviewRequired)!;
const noInterviewTeam = tracks.find((t) => !t.interviewRequired)!;

const APPLICANT_ID = "applicant-1";
const OFFICER_ID = "officer-1";

function trackRow(over: Record<string, unknown> = {}, appOver: Record<string, unknown> = {}) {
  return {
    id: "track-1",
    track: interviewTeam.key,
    status: "SUBMITTED",
    application: {
      id: "app-1",
      userId: APPLICANT_ID,
      state: "SUBMITTED",
      cycleId: "cycle-1",
      fullName: "Ada Lovelace",
      user: { email: "ada@account.test", displayName: "Ada" },
      cycle: { name: "Fall 2026" },
      ...appOver,
    },
    ...over,
  };
}

beforeEach(() => {
  db.applicationEmail.update.mockResolvedValue({});
  db.recruitingTrackConfig.findUnique.mockResolvedValue(null);
  mail.sendEmail.mockResolvedValue({ success: true, messageId: "msg-1" });
});

describe("statusToTemplate", () => {
  it("sends mail for decisions only", () => {
    expect(statusToTemplate("INTERVIEW")).toBe("INTERVIEW");
    expect(statusToTemplate("ACCEPTED")).toBe("ACCEPTED");
    expect(statusToTemplate("REJECTED")).toBe("REJECTED");
    expect(statusToTemplate("IN_REVIEW")).toBeNull();
    expect(statusToTemplate("SUBMITTED")).toBeNull();
  });
});

describe("composeTrackEmail", () => {
  const compose = (template: "INTERVIEW" | "ACCEPTED" | "REJECTED" = "INTERVIEW", override?: { subject: string; body: string }) =>
    composeTrackEmail(db as never, "track-1", template, override);

  it("builds the email to the applicant's ACCOUNT address, tied to the team", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    const email = await compose("ACCEPTED");
    expect(email).toMatchObject({ applicationId: "app-1", applicationTrackId: "track-1", template: "ACCEPTED", toEmail: "ada@account.test" });
    expect(email.subject).toContain(interviewTeam.label);
    expect(email.body).toContain("Ada Lovelace");
    expect(email.body).toContain("Fall 2026");
  });

  it("uses the team's booking link in the interview email when it has one", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    db.recruitingTrackConfig.findUnique.mockResolvedValue({ schedulingUrl: "https://calendar.app.google/abc" });
    expect((await compose()).body).toContain("https://calendar.app.google/abc");
  });

  it("falls back to 'reply to schedule' when there is no booking link", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    expect((await compose()).body).toContain("Reply to this email");
  });

  it("ignores a stored link that isn't a clean https URL", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    db.recruitingTrackConfig.findUnique.mockResolvedValue({ schedulingUrl: "http://calendar.example.com/x" });
    const email = await compose();
    expect(email.body).not.toContain("http://calendar.example.com/x");
    expect(email.body).toContain("Reply to this email");
  });

  it("looks the booking link up for this round and this team", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    await compose();
    expect(db.recruitingTrackConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cycleId_track: { cycleId: "cycle-1", track: interviewTeam.key } } }),
    );
  });

  it("refuses an edited message that needs a booking link the team doesn't have", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    await expect(compose("INTERVIEW", { subject: "Hi", body: "Book here: {{schedulingLink}}" })).rejects.toMatchObject({
      code: "MISSING_SCHEDULING_LINK",
    });
  });

  it("refuses a placeholder that doesn't exist, as a normal validation problem", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    await expect(compose("ACCEPTED", { subject: "Hi", body: "Dear {{applicnatName}}" })).rejects.toMatchObject({
      code: "INVALID",
      fieldErrors: { body: expect.stringContaining("applicnatName") },
    });
  });

  it("sends the officer's edited text, with the placeholders filled in", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    const email = await compose("ACCEPTED", { subject: "Welcome, {{applicantName}}", body: "See you at the meeting.\n\n{{trackName}} team" });
    expect(email.subject).toBe("Welcome, Ada Lovelace");
    expect(email.body).toBe(`See you at the meeting.\n\n${interviewTeam.label} team`);
  });

  it("greets by account name when the application has no name", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow({}, { fullName: "  " }));
    expect((await compose("ACCEPTED")).body).toContain("Ada");
  });

  it("only works on submitted applications, so a draft can't be emailed", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow({}, { state: "DRAFT" }));
    await expect(compose()).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.applicationTrack.findUnique.mockResolvedValue(null);
    await expect(compose()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fills {{replyToEmail}} from RECRUITING_REPLY_TO, and refuses it when unset", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    const draft = { subject: "Hi", body: "Questions? Write to {{replyToEmail}}" };
    await expect(compose("ACCEPTED", draft)).rejects.toMatchObject({ code: "INVALID" });
    vi.stubEnv("RECRUITING_REPLY_TO", "recruiting@club.test");
    expect((await compose("ACCEPTED", draft)).body).toContain("recruiting@club.test");
  });
});

describe("previewDecisionEmail", () => {
  it("returns nothing for a status that sends no email", async () => {
    expect(await previewDecisionEmail("track-1", "IN_REVIEW")).toBeNull();
    expect(db.applicationTrack.findUnique).not.toHaveBeenCalled();
  });

  it("returns the final text plus rendered HTML, and writes nothing", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow());
    const preview = await previewDecisionEmail("track-1", "ACCEPTED");
    expect(preview).toMatchObject({ template: "ACCEPTED", to: "ada@account.test" });
    expect(preview?.html).toContain("<html");
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(db.applicationTrack.update).not.toHaveBeenCalled();
  });
});

describe("deliverEmail", () => {
  const pending = (over: Record<string, unknown> = {}) => ({ id: "email-1", status: "PENDING", toEmail: "ada@account.test", subject: "Hello", body: "Body text", ...over });

  it("sends once with the row id as the idempotency key, then marks it SENT with Resend's message id", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(pending());
    const result = await deliverEmail("email-1");
    expect(result).toEqual({ emailId: "email-1", status: "SENT" });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const [params, options] = mail.sendEmail.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: "recruiting-email:email-1" });
    expect(params).toMatchObject({ to: "ada@account.test", subject: "Hello" });
    expect(db.applicationEmail.update).toHaveBeenCalledWith({
      where: { id: "email-1" },
      data: expect.objectContaining({ status: "SENT", resendMessageId: "msg-1", error: null }),
    });
  });

  it("escapes the stored text when it builds the HTML", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(pending({ body: "Hi <script>alert(1)</script> there" }));
    await deliverEmail("email-1");
    const [params] = mail.sendEmail.mock.calls[0];
    expect(params.html).not.toContain("<script>alert(1)</script>");
    expect(params.html).toContain("&lt;script&gt;");
    expect(params.text).toContain("<script>alert(1)</script>"); // the plain-text part is plain text
  });

  it("sets Reply-To from RECRUITING_REPLY_TO", async () => {
    vi.stubEnv("RECRUITING_REPLY_TO", " recruiting@club.test ");
    db.applicationEmail.findUnique.mockResolvedValue(pending());
    await deliverEmail("email-1");
    expect(mail.sendEmail.mock.calls[0][0].replyTo).toBe("recruiting@club.test");
  });

  it("does not send an email that isn't PENDING", async () => {
    for (const status of ["SENT", "FAILED", "CANCELLED"]) {
      mail.sendEmail.mockClear();
      db.applicationEmail.findUnique.mockResolvedValue(pending({ status }));
      const result = await deliverEmail("email-1");
      expect(mail.sendEmail).not.toHaveBeenCalled();
      expect(result.status).toBe(status === "SENT" ? "SENT" : "SKIPPED");
    }
  });

  it("records a failure and keeps the reason", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(pending());
    mail.sendEmail.mockResolvedValue({ success: false, error: "Email system disabled" });
    const result = await deliverEmail("email-1");
    expect(result).toEqual({ emailId: "email-1", status: "FAILED", error: "Email system disabled" });
    expect(db.applicationEmail.update).toHaveBeenCalledWith({ where: { id: "email-1" }, data: { status: "FAILED", error: "Email system disabled" } });
  });

  it("turns an unexpected exception into a recorded failure", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(pending());
    mail.sendEmail.mockRejectedValue(new Error("socket hang up"));
    const result = await deliverEmail("email-1");
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("socket hang up");
  });

  it("reports an unknown email", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(null);
    await expect(deliverEmail("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deliverEmailSafely", () => {
  it("never throws, so a saved change stays saved when delivery can't even be attempted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.applicationEmail.findUnique.mockRejectedValue(new Error("database is down"));
    const result = await deliverEmailSafely("email-1");
    expect(result).toMatchObject({ emailId: "email-1", status: "FAILED" });
  });
});

describe("resendEmail", () => {
  const failed = (over: Record<string, unknown> = {}) => ({
    id: "email-1",
    status: "FAILED",
    error: "Email system disabled",
    toEmail: "ada@account.test",
    subject: "Hello",
    body: "Body text",
    application: { id: "app-1", userId: APPLICANT_ID },
    ...over,
  });

  it("claims the failed row (FAILED to PENDING), audits it, and sends with a fresh key", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(failed());
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    const result = await resendEmail(OFFICER_ID, "email-1");
    expect(result.status).toBe("SENT");
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({ where: { id: "email-1", status: "FAILED" }, data: { status: "PENDING" } });
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: OFFICER_ID, actionType: "APPLICATION_EMAIL_RESENT", targetUserId: APPLICANT_ID }));
    expect(mail.sendEmail.mock.calls[0][1].idempotencyKey).toMatch(/^recruiting-email:email-1:.+/);
  });

  it("uses a different key every time, otherwise Resend would hand back the old failure", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(failed());
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    await resendEmail(OFFICER_ID, "email-1");
    await resendEmail(OFFICER_ID, "email-1");
    const keys = mail.sendEmail.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("reuses the original key for an email that was interrupted before any result was recorded", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(failed({ error: INTERRUPTED_ERROR }));
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    await resendEmail(OFFICER_ID, "email-1");
    expect(mail.sendEmail.mock.calls[0][1].idempotencyKey).toBe("recruiting-email:email-1");
  });

  it("only resends failed emails", async () => {
    for (const status of ["SENT", "PENDING", "CANCELLED"]) {
      db.applicationEmail.findUnique.mockResolvedValue(failed({ status }));
      await expect(resendEmail(OFFICER_ID, "email-1")).rejects.toMatchObject({ code: "BAD_STATUS" });
    }
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("does not send twice when two officers click at once: the loser's claim matches nothing", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(failed());
    db.applicationEmail.updateMany.mockResolvedValue({ count: 0 });
    await expect(resendEmail(OFFICER_ID, "email-1")).rejects.toMatchObject({ code: "BAD_STATUS" });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(audit.createAuditLog).not.toHaveBeenCalled();
  });

  it("reports an unknown email", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(null);
    await expect(resendEmail(OFFICER_ID, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("failInterruptedEmails", () => {
  it("turns emails stuck PENDING for over 10 minutes into FAILED", async () => {
    db.applicationEmail.updateMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-11-01T12:00:00Z");
    expect(await failInterruptedEmails(now)).toBe(3);
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { status: "PENDING", createdAt: { lt: new Date("2026-11-01T11:50:00Z") } },
      data: { status: "FAILED", error: INTERRUPTED_ERROR },
    });
  });
});

describe("receivedEmailHook", () => {
  const app = (over: Record<string, unknown> = {}) => ({
    fullName: "Ada Lovelace",
    user: { email: "ada@account.test", displayName: "Ada" },
    cycle: { name: "Fall 2026" },
    tracks: [{ track: interviewTeam.key }, { track: noInterviewTeam.key }],
    ...over,
  });
  const tx = (value: unknown) => ({ application: { findUnique: vi.fn().mockResolvedValue(value) } }) as never;
  const ctx = { applicationId: "app-1", userId: APPLICANT_ID, auto: false };

  it("lists every team applied to and is addressed to the account email, at application level", async () => {
    const email = await receivedEmailHook(tx(app()), ctx);
    expect(email).toMatchObject({ applicationId: "app-1", applicationTrackId: null, template: "RECEIVED", toEmail: "ada@account.test" });
    expect(email?.body).toContain(interviewTeam.label);
    expect(email?.body).toContain(noInterviewTeam.label);
    expect(email?.body).not.toContain("we submitted it for you");
  });

  it("explains an automatic submission", async () => {
    const email = await receivedEmailHook(tx(app()), { ...ctx, auto: true });
    expect(email?.body).toContain("we submitted it for you");
  });

  it("never blocks a submission: a problem building it yields no email, not an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { application: { findUnique: vi.fn().mockRejectedValue(new Error("boom")) } } as never;
    expect(await receivedEmailHook(broken, ctx)).toBeNull();
    expect(await receivedEmailHook(tx(null), ctx)).toBeNull();
  });
});

describe("decideAndNotify", () => {
  // A transaction whose client is the same fake, with the extra calls setTrackStatus makes
  const row = () => trackRow({}, {});
  beforeEach(() => {
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.$executeRaw.mockResolvedValue(1);
    db.applicationTrack.findUnique.mockResolvedValue(row());
    db.applicationTrack.update.mockResolvedValue({});
    db.applicationEmail.create.mockResolvedValue({ id: "email-1" });
    db.applicationEmail.findUnique.mockResolvedValue({ id: "email-1", status: "PENDING", toEmail: "ada@account.test", subject: "s", body: "b" });
  });

  it("queues the email with the status change, then sends it after the commit", async () => {
    const result = await decideAndNotify(OFFICER_ID, "track-1", "ACCEPTED", { sendEmail: true });
    expect(db.applicationTrack.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED", decidedById: OFFICER_ID }) }));
    expect(db.applicationEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ template: "ACCEPTED", status: "PENDING", toEmail: "ada@account.test", applicationTrackId: "track-1", applicationId: "app-1" }),
      select: { id: true },
    });
    expect(result.emailId).toBe("email-1");
    expect(result.delivery).toEqual({ emailId: "email-1", status: "SENT" });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the officer chose not to", async () => {
    const result = await decideAndNotify(OFFICER_ID, "track-1", "ACCEPTED", { sendEmail: false });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(result.delivery).toBeNull();
    expect(result.status).toBe("ACCEPTED");
  });

  it("refuses to 'send an email' for a status that has none, before touching anything", async () => {
    await expect(decideAndNotify(OFFICER_ID, "track-1", "IN_REVIEW", { sendEmail: true })).rejects.toMatchObject({ code: "BAD_STATUS" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("the decision survives a failed send: it comes back with a FAILED delivery to resend", async () => {
    mail.sendEmail.mockResolvedValue({ success: false, error: "Email service not configured" });
    const result = await decideAndNotify(OFFICER_ID, "track-1", "REJECTED", { sendEmail: true });
    expect(result.status).toBe("REJECTED");
    expect(result.delivery).toMatchObject({ status: "FAILED", error: "Email service not configured" });
  });

  it("queues the officer's edited wording, not the default", async () => {
    await decideAndNotify(OFFICER_ID, "track-1", "ACCEPTED", { sendEmail: true, override: { subject: "Custom for {{applicantName}}", body: "A personal note." } });
    expect(db.applicationEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ subject: "Custom for Ada Lovelace", body: "A personal note." }),
      select: { id: true },
    });
  });

  it("aborts, without queuing anything, when the edited email can't be built", async () => {
    await expect(
      decideAndNotify(OFFICER_ID, "track-1", "INTERVIEW", { sendEmail: true, override: { subject: "Hi", body: "Book: {{schedulingLink}}" } }),
    ).rejects.toMatchObject({ code: "MISSING_SCHEDULING_LINK" });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("still blocks an officer from deciding their own application, before any email is built", async () => {
    await expect(decideAndNotify(APPLICANT_ID, "track-1", "ACCEPTED", { sendEmail: true })).rejects.toMatchObject({ code: "SELF_REVIEW" });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses Interview for a team that doesn't interview, with no email", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow({ track: noInterviewTeam.key }));
    await expect(decideAndNotify(OFFICER_ID, "track-1", "INTERVIEW", { sendEmail: true })).rejects.toMatchObject({ code: "INTERVIEW_NOT_OFFERED" });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
  });
});
