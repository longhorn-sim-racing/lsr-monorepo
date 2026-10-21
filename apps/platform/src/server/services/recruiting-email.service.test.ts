import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-ins for Prisma, Resend and the audit log: no database, no network.
const db = vi.hoisted(() => ({
  applicationEmail: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  applicationTrack: { findUnique: vi.fn(), update: vi.fn() },
  recruitingTrackConfig: { findUnique: vi.fn() },
  application: { findUnique: vi.fn(), findMany: vi.fn() },
  recruitingCycle: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }));
const notifications = vi.hoisted(() => ({ getEmailUsage: vi.fn(), TRANSACTIONAL_HEADROOM: 10 }));

vi.mock("@/server/db", () => ({ prisma: db }));
vi.mock("@/lib/email/resend", () => mail);
vi.mock("@/server/audit/log", () => audit);
vi.mock("@/server/services/notification.service", () => notifications);

import { addNoInterviewTeam } from "@/lib/recruiting/test-teams";
import { questionsForTrack, tracks } from "@/schemas/recruiting.schema";
import {
  DAILY_LIMIT_ERROR,
  INTERRUPTED_ERROR,
  bulkDecide,
  composeTrackEmail,
  decideAndNotify,
  deliverEmail,
  deliverEmailSafely,
  failInterruptedEmails,
  getEmailQuota,
  previewDecisionEmail,
  receivedEmailHook,
  resendAllFailed,
  resendEmail,
  statusToTemplate,
  sweepAndNotify,
} from "./recruiting-email.service";

// Every shipped team interviews, so add one that doesn't
addNoInterviewTeam();
const interviewTeam = tracks.find((t) => t.interviewRequired)!;
const noInterviewTeam = tracks.find((t) => !t.interviewRequired)!;

const APPLICANT_ID = "applicant-1";
/** Skip the stale-status guard in tests about something else */
const anyOf = (ids: string[]) => Object.fromEntries(ids.map((i) => [i, "ANY" as const]));
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
  db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
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
    // Only a row that is still PENDING can fail: one cancelled in the meantime stays cancelled
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({ where: { id: "email-1", status: "PENDING" }, data: { status: "FAILED", error: "Email system disabled" } });
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
    application: { id: "app-1", userId: APPLICANT_ID, user: { email: "ada@account.test" } },
    ...over,
  });

  it("claims the failed row (FAILED to PENDING), audits it, and sends with a fresh key", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(failed());
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    const result = await resendEmail(OFFICER_ID, "email-1");
    expect(result.status).toBe("SENT");
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { id: "email-1", status: "FAILED" },
      data: { status: "PENDING", claimedAt: expect.any(Date), idempotencyKey: expect.stringMatching(/^recruiting-email:email-1:.+/), toEmail: "ada@account.test" },
    });
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: OFFICER_ID, actionType: "APPLICATION_EMAIL_RESENT", targetUserId: APPLICANT_ID }));
    expect(mail.sendEmail.mock.calls[0][1].idempotencyKey).toMatch(/^recruiting-email:email-1:.+/);
  });

  it("sends a fresh resend to the applicant's CURRENT account email, and records the change", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(failed({ application: { id: "app-1", userId: APPLICANT_ID, user: { email: "ada@new.test" } } }));
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    await resendEmail(OFFICER_ID, "email-1");
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ toEmail: "ada@new.test" }) }));
    expect(mail.sendEmail.mock.calls[0][0].to).toBe("ada@new.test");
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ recipientChanged: { from: "ada@account.test", to: "ada@new.test" } }) }),
    );
  });

  it("keeps the original recipient for an interrupted send, whose delivery may already have happened", async () => {
    db.applicationEmail.findUnique.mockResolvedValue(
      failed({ error: INTERRUPTED_ERROR, application: { id: "app-1", userId: APPLICANT_ID, user: { email: "ada@new.test" } } }),
    );
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    await resendEmail(OFFICER_ID, "email-1");
    expect(mail.sendEmail.mock.calls[0][0].to).toBe("ada@account.test");
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
    // The clock runs from when the send was claimed (a resend sets it), falling back to creation
    const cutoff = new Date("2026-11-01T11:50:00Z");
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { status: "PENDING", OR: [{ claimedAt: { lt: cutoff } }, { claimedAt: null, createdAt: { lt: cutoff } }] },
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
    const result = await decideAndNotify(OFFICER_ID, "track-1", "ACCEPTED", { expectedStatus: "ANY", sendEmail: true });
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
    const result = await decideAndNotify(OFFICER_ID, "track-1", "ACCEPTED", { expectedStatus: "ANY", sendEmail: false });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(result.delivery).toBeNull();
    expect(result.status).toBe("ACCEPTED");
  });

  it("refuses to 'send an email' for a status that has none, before touching anything", async () => {
    await expect(decideAndNotify(OFFICER_ID, "track-1", "IN_REVIEW", { expectedStatus: "ANY", sendEmail: true })).rejects.toMatchObject({ code: "BAD_STATUS" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("the decision survives a failed send: it comes back with a FAILED delivery to resend", async () => {
    mail.sendEmail.mockResolvedValue({ success: false, error: "Email service not configured" });
    const result = await decideAndNotify(OFFICER_ID, "track-1", "REJECTED", { expectedStatus: "ANY", sendEmail: true });
    expect(result.status).toBe("REJECTED");
    expect(result.delivery).toMatchObject({ status: "FAILED", error: "Email service not configured" });
  });

  it("queues the officer's edited wording, not the default", async () => {
    await decideAndNotify(OFFICER_ID, "track-1", "ACCEPTED", { expectedStatus: "ANY", sendEmail: true, override: { subject: "Custom for {{applicantName}}", body: "A personal note." } });
    expect(db.applicationEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ subject: "Custom for Ada Lovelace", body: "A personal note." }),
      select: { id: true },
    });
  });

  it("aborts, without queuing anything, when the edited email can't be built", async () => {
    await expect(
      decideAndNotify(OFFICER_ID, "track-1", "INTERVIEW", { expectedStatus: "ANY", sendEmail: true, override: { subject: "Hi", body: "Book: {{schedulingLink}}" } }),
    ).rejects.toMatchObject({ code: "MISSING_SCHEDULING_LINK" });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("still blocks an officer from deciding their own application, before any email is built", async () => {
    await expect(decideAndNotify(APPLICANT_ID, "track-1", "ACCEPTED", { expectedStatus: "ANY", sendEmail: true })).rejects.toMatchObject({ code: "SELF_REVIEW" });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses Interview for a team that doesn't interview, with no email", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow({ track: noInterviewTeam.key }));
    await expect(decideAndNotify(OFFICER_ID, "track-1", "INTERVIEW", { expectedStatus: "ANY", sendEmail: true })).rejects.toMatchObject({ code: "INTERVIEW_NOT_OFFERED" });
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
  });
});

describe("getEmailQuota", () => {
  it("takes the count from the shared usage (announcements, receipts and recruiting mail) and holds the receipts headroom back", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 55, dailyLimit: 100 });
    expect(await getEmailQuota()).toEqual({ sentToday: 55, dailyLimit: 100, left: 35 });
  });

  it("never reports less than zero left, and no limit means no cap", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 120, dailyLimit: 100 });
    expect((await getEmailQuota()).left).toBe(0);
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 500, dailyLimit: null });
    expect(await getEmailQuota()).toMatchObject({ dailyLimit: null, left: null });
  });
});

describe("bulkDecide", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `track-${i + 1}`);
  beforeEach(() => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 15, dailyLimit: 100 }); // 75 left after the headroom
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.$executeRaw.mockResolvedValue(1);
    db.applicationTrack.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => trackRow({ id: where.id }));
    db.applicationTrack.update.mockResolvedValue({});
    db.applicationEmail.create.mockImplementation(async ({ data }: { data: { applicationTrackId: string } }) => ({ id: `email-for-${data.applicationTrackId}` }));
    db.applicationEmail.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, status: "PENDING", toEmail: "ada@account.test", subject: "s", body: "b" }));
  });

  it("decides every selected application and emails each applicant", async () => {
    const result = await bulkDecide(OFFICER_ID, ids(3), "ACCEPTED", { expectedStatuses: anyOf(ids(3)), sendEmail: true });
    expect(result).toEqual({ total: 3, decided: 3, emailsSent: 3, emailsFailed: 0, failures: [] });
    expect(db.applicationTrack.update).toHaveBeenCalledTimes(3);
    expect(mail.sendEmail).toHaveBeenCalledTimes(3);
  });

  it("sends nothing and skips the quota check when the officer chose not to email", async () => {
    const result = await bulkDecide(OFFICER_ID, ids(3), "IN_REVIEW", { expectedStatuses: anyOf(ids(3)), sendEmail: false });
    expect(result.decided).toBe(3);
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(notifications.getEmailUsage).not.toHaveBeenCalled();
  });

  it("collapses a repeated id so nobody is decided or emailed twice", async () => {
    const result = await bulkDecide(OFFICER_ID, ["track-1", "track-1", "track-2"], "ACCEPTED", { expectedStatuses: anyOf(["track-1", "track-1", "track-2"]), sendEmail: true });
    expect(result.total).toBe(2);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["nothing selected", []],
    ["more than 100", ids(101)],
    ["not a list", "track-1"],
    ["a list with a blank id", ["track-1", ""]],
  ])("rejects %s", async (_name, input) => {
    await expect(bulkDecide(OFFICER_ID, input, "ACCEPTED", { sendEmail: true, expectedStatuses: {} })).rejects.toMatchObject({ code: "INVALID" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to 'send an email' for a status that has none", async () => {
    await expect(bulkDecide(OFFICER_ID, ids(2), "IN_REVIEW", { expectedStatuses: anyOf(ids(2)), sendEmail: true })).rejects.toMatchObject({ code: "BAD_STATUS" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses the whole batch up front when it would go past today's email limit, deciding nobody", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 80, dailyLimit: 100 }); // 10 left after the headroom
    await expect(bulkDecide(OFFICER_ID, ids(11), "ACCEPTED", { expectedStatuses: anyOf(ids(11)), sendEmail: true })).rejects.toMatchObject({
      code: "EMAIL_LIMIT",
      message: expect.stringContaining("only 10 of today's 100"),
    });
    expect(db.applicationTrack.update).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
    // exactly what's left is fine
    const ok = await bulkDecide(OFFICER_ID, ids(10), "ACCEPTED", { expectedStatuses: anyOf(ids(10)), sendEmail: true });
    expect(ok.decided).toBe(10);
  });

  it("goes ahead past the limit only when told to", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 99, dailyLimit: 100 });
    const result = await bulkDecide(OFFICER_ID, ids(5), "ACCEPTED", { expectedStatuses: anyOf(ids(5)), sendEmail: true, ignoreLimit: true });
    expect(result.decided).toBe(5);
  });

  it("has no cap on a plan without a daily limit", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 5000, dailyLimit: null });
    expect((await bulkDecide(OFFICER_ID, ids(40), "ACCEPTED", { expectedStatuses: anyOf(ids(40)), sendEmail: true })).decided).toBe(40);
  });

  it("carries on past an application it can't decide, and reports why", async () => {
    db.applicationTrack.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "track-gone") return null;
      if (where.id === "track-mine") return trackRow({ id: where.id }, { userId: OFFICER_ID });
      return trackRow({ id: where.id });
    });
    const result = await bulkDecide(OFFICER_ID, ["track-1", "track-gone", "track-mine", "track-2"], "ACCEPTED", { expectedStatuses: anyOf(["track-1", "track-gone", "track-mine", "track-2"]), sendEmail: true });
    expect(result.decided).toBe(2);
    expect(result.emailsSent).toBe(2);
    expect(result.failures).toEqual([
      { applicationTrackId: "track-gone", error: "Application not found." },
      { applicationTrackId: "track-mine", error: "You can't review or decide your own application." },
    ]);
  });

  it("separates emails that went out from ones that failed (the decisions stand either way)", async () => {
    mail.sendEmail.mockResolvedValueOnce({ success: true, messageId: "m1" }).mockResolvedValueOnce({ success: false, error: "Daily quota exceeded" });
    const result = await bulkDecide(OFFICER_ID, ids(2), "REJECTED", { expectedStatuses: anyOf(ids(2)), sendEmail: true });
    expect(result).toMatchObject({ decided: 2, emailsSent: 1, emailsFailed: 1 });
  });
});

describe("resendAllFailed", () => {
  const failedRow = (id: string) => ({ id, status: "FAILED", error: "Daily quota exceeded", toEmail: "ada@account.test", subject: "s", body: "b", application: { id: "app-1", userId: APPLICANT_ID, user: { email: "ada@account.test" } } });
  beforeEach(() => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    db.applicationEmail.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => failedRow(where.id));
  });

  it("resends each failed email in the round and reports how many went out", async () => {
    db.applicationEmail.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    expect(await resendAllFailed(OFFICER_ID, "cycle-1")).toEqual({ total: 3, sent: 3, failed: 0, cancelled: 0 });
    expect(db.applicationEmail.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "FAILED", application: { cycleId: "cycle-1" } }, take: 100 }));
    expect(mail.sendEmail).toHaveBeenCalledTimes(3);
  });

  it("first turns mail stuck PENDING into FAILED so it is included", async () => {
    db.applicationEmail.findMany.mockResolvedValue([]);
    await resendAllFailed(OFFICER_ID, "cycle-1");
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "PENDING" }), data: { status: "FAILED", error: INTERRUPTED_ERROR } }));
  });

  it("counts a still-failing email as failed without stopping", async () => {
    db.applicationEmail.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    mail.sendEmail.mockResolvedValueOnce({ success: false, error: "Daily quota exceeded" }).mockResolvedValueOnce({ success: true, messageId: "m2" });
    expect(await resendAllFailed(OFFICER_ID, "cycle-1")).toEqual({ total: 2, sent: 1, failed: 1, cancelled: 0 });
  });

  it("won't start a batch that is bigger than what's left of today's limit, unless told to", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 88, dailyLimit: 100 }); // 2 left after the headroom
    db.applicationEmail.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    await expect(resendAllFailed(OFFICER_ID, "cycle-1")).rejects.toMatchObject({ code: "EMAIL_LIMIT" });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect((await resendAllFailed(OFFICER_ID, "cycle-1", { ignoreLimit: true })).total).toBe(3);
  });

  it("does nothing, and checks nothing, when no email has failed", async () => {
    db.applicationEmail.findMany.mockResolvedValue([]);
    expect(await resendAllFailed(OFFICER_ID, "cycle-1")).toEqual({ total: 0, sent: 0, failed: 0, cancelled: 0 });
    expect(notifications.getEmailUsage).not.toHaveBeenCalled();
  });
});

describe("a decision that changed", () => {
  beforeEach(() => {
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.$executeRaw.mockResolvedValue(1);
    db.applicationTrack.findUnique.mockResolvedValue(trackRow({ status: "ACCEPTED" }));
    db.applicationTrack.update.mockResolvedValue({});
    db.applicationEmail.updateMany.mockResolvedValue({ count: 1 });
    db.applicationEmail.create.mockResolvedValue({ id: "email-2" });
    db.applicationEmail.findUnique.mockResolvedValue({ id: "email-2", status: "PENDING", toEmail: "ada@account.test", subject: "s", body: "b" });
  });

  it("cancels the team's unsent decision emails in the same transaction, before queuing the new one", async () => {
    await decideAndNotify(OFFICER_ID, "track-1", "REJECTED", { expectedStatus: "ANY", sendEmail: true });
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { applicationTrackId: "track-1", template: { in: ["INTERVIEW", "ACCEPTED", "REJECTED"] }, status: { in: ["FAILED", "PENDING"] } },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(db.applicationEmail.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.applicationEmail.create.mock.invocationCallOrder[0]);
  });

  it("refuses to overwrite a status the officer didn't see, saving and emailing nothing", async () => {
    await expect(decideAndNotify(OFFICER_ID, "track-1", "REJECTED", { sendEmail: true, expectedStatus: "IN_REVIEW" })).rejects.toMatchObject({
      code: "STATUS_CHANGED",
    });
    expect(db.applicationTrack.update).not.toHaveBeenCalled();
    expect(db.applicationEmail.create).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("goes ahead when the status is still the one the officer saw", async () => {
    const result = await decideAndNotify(OFFICER_ID, "track-1", "REJECTED", { sendEmail: true, expectedStatus: "ACCEPTED" });
    expect(result.status).toBe("REJECTED");
  });

  it("in a bulk change, refuses only the rows that changed", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    db.applicationTrack.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      trackRow({ id: where.id, status: where.id === "track-2" ? "ACCEPTED" : "IN_REVIEW" }),
    );
    const result = await bulkDecide(OFFICER_ID, ["track-1", "track-2"], "REJECTED", {
      sendEmail: false,
      expectedStatuses: { "track-1": "IN_REVIEW", "track-2": "IN_REVIEW" },
    });
    expect(result.decided).toBe(1);
    expect(result.failures).toEqual([{ applicationTrackId: "track-2", error: expect.stringContaining("Someone else just changed this") }]);
  });

  it("will not resend an old decision email once the status no longer matches it", async () => {
    db.applicationEmail.findUnique.mockResolvedValue({
      id: "email-1",
      status: "FAILED",
      error: "Daily quota exceeded",
      template: "ACCEPTED",
      toEmail: "ada@account.test",
      subject: "You are in",
      body: "b",
      idempotencyKey: null,
      applicationTrack: { status: "REJECTED" },
      application: { id: "app-1", userId: APPLICANT_ID, user: { email: "ada@account.test" } },
    });
    // A result, not an error, so the page can refresh and drop the stale Resend button
    expect(await resendEmail(OFFICER_ID, "email-1")).toMatchObject({ emailId: "email-1", status: "CANCELLED" });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { id: "email-1", status: "FAILED" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "APPLICATION_EMAIL_CANCELLED", entityId: "email-1" }));
  });

  it("resends a decision email that still matches the status", async () => {
    db.applicationEmail.findUnique.mockResolvedValue({
      id: "email-1",
      status: "FAILED",
      error: "Daily quota exceeded",
      template: "REJECTED",
      toEmail: "ada@account.test",
      subject: "s",
      body: "b",
      idempotencyKey: null,
      applicationTrack: { status: "REJECTED" },
      application: { id: "app-1", userId: APPLICANT_ID, user: { email: "ada@account.test" } },
    });
    expect((await resendEmail(OFFICER_ID, "email-1")).status).toBe("SENT");
  });

  it("drops braces from the applicant's name, so a second compose of an edited email can't read it as a placeholder", async () => {
    db.applicationTrack.findUnique.mockResolvedValue(trackRow({}, { fullName: "Ada {{statusUrl}} Lovelace" }));
    const email = await composeTrackEmail(db as never, "track-1", "ACCEPTED");
    expect(email.body).toContain("Ada statusUrl Lovelace");
    expect(email.body).not.toContain("{{statusUrl}}");
  });
});

describe("sending", () => {
  const pending = { id: "email-1", status: "PENDING", toEmail: "ada@account.test", subject: "Hello", body: "Body text", idempotencyKey: null };

  it("does not mark an email failed when Resend accepted it but saving the result threw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.applicationEmail.findUnique.mockResolvedValue(pending);
    db.applicationEmail.update.mockRejectedValue(new Error("connection reset"));
    const result = await deliverEmail("email-1");
    expect(result).toEqual({ emailId: "email-1", status: "SENT" });
    expect(db.applicationEmail.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("sends with the key stored on the row, so a retry after a crash can't deliver twice", async () => {
    db.applicationEmail.findUnique.mockResolvedValue({ ...pending, idempotencyKey: "recruiting-email:email-1:stored" });
    await deliverEmail("email-1");
    expect(mail.sendEmail.mock.calls[0][1]).toEqual({ idempotencyKey: "recruiting-email:email-1:stored" });
  });
});

describe("sweepAndNotify email handling", () => {
  beforeEach(() => {
    db.recruitingCycle.findMany.mockResolvedValue([]);
  });

  it("retries confirmations an earlier run never sent", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    db.applicationEmail.findMany.mockResolvedValueOnce([{ id: "email-1", claimedAt: new Date("2026-11-01T11:00:00Z") }]).mockResolvedValue([]);
    db.applicationEmail.findUnique.mockResolvedValue({ id: "email-1", status: "PENDING", toEmail: "a@b.test", subject: "s", body: "b", idempotencyKey: null });
    const summary = await sweepAndNotify({ now: new Date("2026-11-01T12:00:00Z") });
    expect(summary.emailsSent).toBe(1);
  });

  it("retries an earlier run's row even when today's limit is used up: it keeps its key, so nothing is sent twice", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 95, dailyLimit: 100 }); // inside the receipts headroom: nothing left
    db.applicationEmail.findMany.mockResolvedValueOnce([{ id: "email-1", claimedAt: new Date("2026-11-01T11:00:00Z") }]).mockResolvedValue([]);
    db.applicationEmail.findUnique.mockResolvedValue({ id: "email-1", status: "PENDING", toEmail: "a@b.test", subject: "s", body: "b", idempotencyKey: "recruiting-email:email-1" });
    const summary = await sweepAndNotify({ now: new Date("2026-11-01T12:00:00Z") });
    expect(summary).toMatchObject({ emailsSent: 1, emailsOverLimit: 0 });
    expect(mail.sendEmail.mock.calls[0][1]).toEqual({ idempotencyKey: "recruiting-email:email-1" });
    // never marked failed for the limit: it may already have been delivered
    expect(db.applicationEmail.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ error: DAILY_LIMIT_ERROR }) }));
  });

  it("treats a row the last run was cut off before sending as new: it respects today's limit instead of skipping it", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 95, dailyLimit: 100 }); // inside the receipts headroom: nothing left
    db.applicationEmail.findMany.mockResolvedValueOnce([{ id: "email-1", claimedAt: null }]).mockResolvedValue([]);
    const summary = await sweepAndNotify({ now: new Date("2026-11-01T12:00:00Z") });
    expect(summary).toMatchObject({ emailsSent: 0, emailsOverLimit: 1 });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    // it was never attempted, so marking it failed is safe (and only while it is still PENDING)
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { id: "email-1", status: "PENDING" },
      data: { status: "FAILED", error: DAILY_LIMIT_ERROR },
    });
  });

  it("retries rows marked interrupted with their stored key, claiming each first", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    // first findMany: stale PENDING (none); second: interrupted FAILED rows
    db.applicationEmail.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "email-1" }]);
    db.applicationEmail.findUnique.mockResolvedValue({ id: "email-1", status: "PENDING", toEmail: "a@b.test", subject: "s", body: "b", idempotencyKey: "recruiting-email:email-1" });
    const summary = await sweepAndNotify({ now: new Date("2026-11-01T12:00:00Z") });
    expect(db.applicationEmail.updateMany).toHaveBeenCalledWith({
      where: { id: "email-1", status: "FAILED", error: INTERRUPTED_ERROR },
      data: { status: "PENDING", error: null, claimedAt: new Date("2026-11-01T12:00:00Z") },
    });
    expect(summary.emailsSent).toBe(1);
    expect(mail.sendEmail.mock.calls[0][1]).toEqual({ idempotencyKey: "recruiting-email:email-1" });
  });

  it("does not send a row that was cancelled between being read and being claimed", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    db.applicationEmail.findMany.mockResolvedValue([]);
    db.applicationEmail.findUnique.mockResolvedValue({ id: "email-1", status: "PENDING", toEmail: "a@b.test", subject: "s", body: "b", idempotencyKey: null });
    db.applicationEmail.updateMany.mockResolvedValue({ count: 0 }); // the claim matches nothing: no longer PENDING
    expect(await deliverEmail("email-1")).toEqual({ emailId: "email-1", status: "SKIPPED" });
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("only looks at rounds it hasn't already been through cleanly (the admin button re-checks one)", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    db.applicationEmail.findMany.mockResolvedValue([]);
    await sweepAndNotify({ now: new Date("2026-11-01T12:00:00Z") });
    expect(db.recruitingCycle.findMany.mock.calls[0][0].where).toMatchObject({ sweptAt: null });
    await sweepAndNotify({ cycleId: "c1", now: new Date("2026-11-01T12:00:00Z") });
    expect(db.recruitingCycle.findMany.mock.calls[1][0].where).toMatchObject({ id: "c1" });
    expect(db.recruitingCycle.findMany.mock.calls[1][0].where).not.toHaveProperty("sweptAt");
  });
});

describe("sweepAndNotify marking a round as swept", () => {
  const NOW = new Date("2026-11-01T12:00:00Z");
  const CLOSES = new Date("2026-10-17T04:59:00Z");
  const opensAt = new Date("2026-10-01T00:00:00Z");
  const easyTeam = tracks.find((t) => questionsForTrack(t.key).every((q) => !q.required))!.key;
  const draft = {
    id: "a1",
    userId: "u1",
    state: "DRAFT",
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    eid: "al123",
    gradYear: 2028,
    major: "Math",
    resumeUrl: "https://example.com/r.pdf",
    genericAnswers: {},
    tracks: [{ id: "t1", track: easyTeam, answers: {} }],
  };
  const sweptWrites = () =>
    db.recruitingCycle.updateMany.mock.calls.filter(([arg]) => (arg as { data?: { sweptAt?: unknown } }).data?.sweptAt !== undefined);

  beforeEach(() => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 });
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.$executeRaw.mockResolvedValue(1);
    db.applicationEmail.findMany.mockResolvedValue([]);
    db.recruitingCycle.findMany.mockResolvedValue([{ id: "c1" }]);
    db.recruitingCycle.findUnique.mockResolvedValue({ id: "c1", opensAt, closesAt: CLOSES });
  });

  it("marks a cleanly swept round, only while its deadline is still the one the pass used", async () => {
    db.application.findMany.mockResolvedValue([]);
    await sweepAndNotify({ now: NOW });
    expect(sweptWrites()).toEqual([[{ where: { id: "c1", sweptAt: null, closesAt: { equals: CLOSES, lte: NOW } }, data: { sweptAt: NOW } }]]);
  });

  it("does not mark a round whose deadline was extended mid-sweep", async () => {
    db.recruitingCycle.findUnique
      .mockResolvedValueOnce({ id: "c1", opensAt, closesAt: CLOSES })
      .mockResolvedValueOnce({ id: "c1", opensAt, closesAt: new Date("2026-11-20T04:59:00Z") });
    db.application.findMany.mockResolvedValue([draft]);
    const summary = await sweepAndNotify({ now: NOW });
    expect(summary.submitted).toBe(0);
    expect(sweptWrites()).toEqual([]);
  });

  it("does not mark a round when a draft failed, so the next run tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.application.findMany.mockResolvedValue([draft]);
    db.$transaction.mockRejectedValue(new Error("deadlock"));
    const summary = await sweepAndNotify({ now: NOW });
    expect(summary.failed).toBe(1);
    expect(sweptWrites()).toEqual([]);
  });
});
