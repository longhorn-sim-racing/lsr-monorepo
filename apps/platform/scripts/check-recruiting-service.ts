// Integration check for src/server/services/recruiting.service.ts against the LOCAL database.
// There is no test runner and CI has no database, so run this by hand after changing the
// recruiting service or schema:
//
//   cd apps/platform
//   NODE_ENV=production npx tsx scripts/check-recruiting-service.ts
//
// (NODE_ENV=production only quiets Prisma's per-query logging.) It needs `npx supabase start`,
// a migrated + seeded database (`pnpm db:reset`: it uses the seeded active round `fall-2026`),
// and it refuses to run unless DATABASE_URL points at localhost.
// It assumes a database with NO demo or mail-test data: two checks (the daily email quota and "a new round
// copies the previous round's booking links") count what is already there, so run it after `pnpm db:reset`
// or after `npx tsx scripts/seed-recruiting-demo.ts clean`. It creates its own users and
// deletes everything it created when it finishes, pass or fail.
//
// It also covers recruiting-email.service.ts, but NEVER sends real mail: RESEND_API_KEY is cleared
// below, so every delivery ends FAILED ("Email service not configured"), which is exactly what
// lets the queuing, rollback and resend paths be checked against a real database.

// Must stay before anything sends: with no key, sendEmail() refuses instead of calling Resend.
process.env.RESEND_API_KEY = "";

import { prisma } from "../src/server/db";
import {
  bulkDecide,
  composeTrackEmail,
  decideAndNotify,
  failInterruptedEmails,
  getEmailQuota,
  listEmailsNeedingAttention,
  previewDecisionEmail,
  resendAllFailed,
  resendEmail,
  submitAndNotify,
  sweepAndNotify,
} from "../src/server/services/recruiting-email.service";
import { createCycle, deleteCycle, getTrackConfigs, listCycles, saveTrackConfig, setActiveCycle, updateCycle } from "../src/server/services/recruiting-cycle.service";
import { exportRound } from "../src/server/services/recruiting-export.service";
import { countEmailsNeedingAttention } from "../src/server/repos/application.repo";
import { tracks } from "../src/schemas/recruiting.schema";
import { NO_INTERVIEW_TEAM, addNoInterviewTeam } from "../src/lib/recruiting/test-teams";
import {
  RecruitingError,
  addReview,
  getApplicantStatus,
  getActiveRound,
  getApplicationDetail,
  getMyApplication,
  getOrCreateDraft,
  listTrackApplications,
  recordApplicationViewed,
  saveDraft,
  setSelectedTracks,
  setTrackStatus,
  submitApplication,
  sweepCycle,
  type RecruitingErrorCode,
} from "../src/server/services/recruiting.service";

// Every shipped team interviews; the checks below also need one that does not
addNoInterviewTeam();

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error("Refusing to run: DATABASE_URL does not point at localhost.");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}
async function expectError(
  name: string,
  fn: () => Promise<unknown>,
  code: RecruitingErrorCode,
  extra?: (e: RecruitingError) => boolean,
) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    const ok = e instanceof RecruitingError && e.code === code && (extra ? extra(e) : true);
    check(name, ok, e instanceof RecruitingError ? `code=${e.code} msg=${e.message}` : String(e));
  }
}

const run = `t4${Date.now().toString(36)}`;
const userIds: string[] = [];
async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const id = `${run}-${label}`;
  userIds.push(id);
  return prisma.user.create({
    data: {
      id,
      email: `${id}@example.com`,
      handle: id,
      displayName: `Test ${label}`,
      eid: `e${run}${label}`.slice(0, 16),
      gradYear: 2028,
      major: "Testing",
      ...extra,
    },
  });
}

const IN = new Date("2026-11-15T12:00:00Z");
const BEFORE = new Date("2026-09-01T12:00:00Z");
const AFTER = new Date("2027-01-01T12:00:00Z");
/** A complete set of answers for each real team that has required questions. */
const MEDIA_FULL = { media_tools: ["Canva"], media_social: "Ran a club account", media_portfolio: "https://example.com/work", media_favorite: "My logo", media_hours: "1–3" };
const COMP_FULL = { comp_skills: ["Commentating races/events"], comp_exec: "x", comp_challenge: "x", comp_endurance: "Yes", comp_hours: "2" };
const GENERIC = {}; // there are no general questions
const RESUME = "https://example.com/resume.pdf";

async function main() {
  const cycle = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
  if (!cycle || cycle.slug !== "fall-2026") {
    console.error("Needs the seeded active round `fall-2026` (run `pnpm db:reset`).");
    process.exit(1);
  }

  const u1 = await makeUser("u1");
  const u2 = await makeUser("u2");
  const u3 = await makeUser("u3");
  const officer = await makeUser("officer");
  const pending = await makeUser("pending", { status: "pending_verification" });

  console.log("--- round window ---");
  await expectError("before opening: ROUND_NOT_OPEN_YET", () => getOrCreateDraft(u1.id, BEFORE), "ROUND_NOT_OPEN_YET");
  await expectError("after closing: ROUND_CLOSED", () => getOrCreateDraft(u1.id, AFTER), "ROUND_CLOSED");
  await expectError("closesAt itself is already closed (exclusive)", () => getOrCreateDraft(u1.id, cycle.closesAt), "ROUND_CLOSED");
  check("nothing was created by rejected calls", (await getMyApplication(u1.id)) === null);

  console.log("--- drafts ---");
  await expectError("unverified account can't start", () => getOrCreateDraft(pending.id, IN), "FORBIDDEN");
  const d1 = await getOrCreateDraft(u1.id, IN);
  check("draft starts in DRAFT with the round's form version", d1.state === "DRAFT" && d1.formVersion === cycle.formVersion);
  check("profile is copied from the account", d1.fullName === "Test u1" && d1.email === u1.email && d1.gradYear === 2028 && d1.major === "Testing");
  check("getOrCreateDraft is idempotent", (await getOrCreateDraft(u1.id, IN)).id === d1.id);
  {
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => getOrCreateDraft(u2.id, IN)));
    const ids = new Set(settled.map((s) => (s.status === "fulfilled" ? s.value.id : "ERR")));
    const count = await prisma.application.count({ where: { userId: u2.id } });
    check("5 simultaneous first-saves create exactly one application", count === 1 && ids.size === 1 && !ids.has("ERR"), `count=${count} ids=${[...ids]}`);
  }

  console.log("--- saving progress ---");
  await expectError("unknown top-level field rejected (can't smuggle `state`)", () => saveDraft(u1.id, { state: "SUBMITTED" }, IN), "INVALID");
  await expectError("can't set another user's id", () => saveDraft(u1.id, { userId: u2.id }, IN), "INVALID");
  await expectError("profile email must stay the account email", () => saveDraft(u1.id, { profile: { email: "someone-else@example.com" } }, IN), "INVALID", (e) => "profile.email" in (e.fieldErrors ?? {}));
  // There are no general questions: every answer belongs to a team's page, so choose a team first.
  await setSelectedTracks(u1.id, ["competition"], IN);
  await saveDraft(u1.id, { step: "team:competition", profile: { major: "Math" }, trackAnswers: { "competition": { comp_exec: "  Love racing  " } } }, IN);
  await saveDraft(u1.id, { trackAnswers: { "competition": { comp_hours: "2" } } }, IN);
  {
    const a = await getMyApplication(u1.id);
    const g = a?.tracks.find((t) => t.track === "competition")?.answers as Record<string, unknown>;
    check("pages merge instead of overwriting", g.comp_exec === "Love racing" && g.comp_hours === "2", JSON.stringify(g));
    check("text is trimmed and the step is remembered", a?.draftStep === "team:competition" && a.major === "Math");
  }
  await saveDraft(u1.id, { trackAnswers: { "competition": { comp_exec: "" } } }, IN);
  check("clearing a field removes it", !("comp_exec" in ((await getMyApplication(u1.id))?.tracks.find((t) => t.track === "competition")?.answers as Record<string, unknown>)));
  await expectError("unknown question id rejected", () => saveDraft(u1.id, { trackAnswers: { "competition": { nope: "x" } } }, IN), "INVALID");
  await expectError("an option that isn't listed is rejected", () => saveDraft(u1.id, { trackAnswers: { "competition": { comp_hours: "99 hours" } } }, IN), "INVALID");
  await expectError("general answers are rejected: there are no general questions", () => saveDraft(u1.id, { genericAnswers: { why_join: "x" } }, IN), "INVALID");
  await expectError("answers for a team that isn't chosen rejected", () => saveDraft(u1.id, { trackAnswers: { "media": { media_social: "x" } } }, IN), "INVALID");
  await expectError("http resume link rejected", () => saveDraft(u1.id, { resumeUrl: "http://example.com/r.pdf" }, IN), "INVALID");
  await expectError("portfolio links are no longer accepted", () => saveDraft(u1.id, { portfolioLinks: [{ label: "GitHub", url: "https://github.com/ada" }] }, IN), "INVALID");
  {
    // all-or-nothing: one valid change + one invalid change writes nothing
    const before = await getMyApplication(u1.id);
    await expectError("a bad answer rejects the whole save", () => saveDraft(u1.id, { profile: { major: "Chemistry" }, trackAnswers: { "competition": { comp_hours: "99 hours" } } }, IN), "INVALID");
    const after = await getMyApplication(u1.id);
    check("...and nothing from it was written", after?.major === before?.major, `${before?.major} -> ${after?.major}`);
  }

  console.log("--- choosing teams ---");
  await expectError("unknown team rejected", () => setSelectedTracks(u1.id, ["nope"], IN), "INVALID");
  await expectError("duplicate team rejected", () => setSelectedTracks(u1.id, ["media", "media"], IN), "INVALID");
  await expectError("non-array rejected", () => setSelectedTracks(u1.id, "media", IN), "INVALID");
  {
    const r = await setSelectedTracks(u1.id, ["media", NO_INTERVIEW_TEAM], IN);
    check("adds teams", r.added.length === 2 && r.application.tracks.length === 2);
    const again = await setSelectedTracks(u1.id, ["media", NO_INTERVIEW_TEAM], IN);
    check("same selection is a no-op", again.added.length === 0 && again.removed.length === 0);
  }
  await saveDraft(u1.id, { trackAnswers: { "media": MEDIA_FULL, [NO_INTERVIEW_TEAM]: {} } }, IN);
  {
    const r = await setSelectedTracks(u1.id, ["media"], IN);
    check("dropping a team removes its row and answers", r.removed.join() === NO_INTERVIEW_TEAM && r.application.tracks.length === 1);
    check("the kept team's answers survive", JSON.stringify(r.application.tracks[0].answers).includes("Ran a club account"));
  }
  await setSelectedTracks(u1.id, ["media", NO_INTERVIEW_TEAM], IN);

  console.log("--- submitting ---");
  await expectError("incomplete application can't be submitted", () => submitApplication(u1.id, IN), "INCOMPLETE", (e) => !!e.report && !e.report.complete && e.report.sections.some((s) => !s.complete));
  check("it is still a draft", (await getMyApplication(u1.id))?.state === "DRAFT");
  await saveDraft(u1.id, { genericAnswers: GENERIC, resumeUrl: RESUME, trackAnswers: { "media": MEDIA_FULL } }, IN);
  await expectError("submit after closing is rejected", () => submitApplication(u1.id, AFTER), "ROUND_CLOSED");
  await expectError("saving after closing is rejected", () => saveDraft(u1.id, { step: "x" }, AFTER), "ROUND_CLOSED");
  {
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => submitApplication(u1.id, IN)));
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const dupes = settled.filter((s) => s.status === "rejected" && s.reason instanceof RecruitingError && s.reason.code === "ALREADY_SUBMITTED").length;
    check("5 simultaneous submits: exactly one wins", ok === 1 && dupes === 4, `ok=${ok} already=${dupes}`);
    const audits = await prisma.auditLog.count({ where: { entityType: "APPLICATION", entityId: d1.id, actionType: "APPLICATION_SUBMITTED" } });
    check("...and exactly one audit entry was written", audits === 1, `audits=${audits}`);
  }
  {
    const a = await getMyApplication(u1.id);
    check("submitted: state, time, and not auto-submitted", a?.state === "SUBMITTED" && !!a.submittedAt && a.autoSubmitted === false);
  }
  await expectError("saving after submit is rejected", () => saveDraft(u1.id, { step: "x" }, IN), "ALREADY_SUBMITTED");
  await expectError("changing teams after submit is rejected", () => setSelectedTracks(u1.id, ["media"], IN), "ALREADY_SUBMITTED");
  await expectError("submitting twice is rejected", () => submitApplication(u1.id, IN), "ALREADY_SUBMITTED");

  console.log("--- isolation between applicants ---");
  {
    const a2 = await getMyApplication(u2.id);
    check("u2 sees their own empty draft, not u1's", a2 !== null && a2.id !== d1.id && a2.state === "DRAFT" && a2.tracks.length === 0);
    const view2 = await getApplicantStatus(u2.id, IN);
    check("u2's status view contains none of u1's data", !JSON.stringify(view2).includes("Ran a club account") && !JSON.stringify(view2).includes(u1.email));
    check("a user with no application gets null", (await getApplicantStatus(officer.id, IN)).application === null);
  }

  console.log("--- a second applicant: draft stays invisible to officers ---");
  await setSelectedTracks(u3.id, [NO_INTERVIEW_TEAM, "competition"], IN);
  await saveDraft(u3.id, { genericAnswers: GENERIC, resumeUrl: RESUME, trackAnswers: { "competition": COMP_FULL } }, IN);
  const d3 = await getMyApplication(u3.id);
  {
    const list = await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: run });
    check("the draft's teams are not in the officer list", !list.rows.some((r) => r.application.userId === u3.id));
    check("the submitted application's two teams are", list.rows.filter((r) => r.application.userId === u1.id).length === 2, `rows=${list.rows.length}`);
    check("opening a draft by id returns null", (await getApplicationDetail(d3!.id, null)) === null);
    const v3 = await getApplicantStatus(u3.id, IN);
    check("draft statuses are hidden from the applicant too", v3.application?.tracks.every((t) => t.status === null) === true);
  }
  await submitApplication(u3.id, IN);

  console.log("--- officer list and filters ---");
  {
    const all = await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: run });
    check("both applicants appear (4 team rows)", all.total === 4 && all.rows.length === 4, `total=${all.total}`);
    check("filter by team", (await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: run, track: "competition" })).rows.every((r) => r.track === "competition"));
    check("filter by status", (await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: run, status: "ACCEPTED" })).total === 0);
    check("search matches name or email", (await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: "TEST U3" })).rows.some((r) => r.application.userId === u3.id));
    check("autoSubmitted filter", (await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: run, autoSubmitted: true })).total === 0);
    const detail = await getApplicationDetail(d1.id, null);
    check("detail returns the applicant narrowly (account email, no full User row)", detail !== null && detail.user.email === u1.email && !("eid" in detail.user) && !("marketingOptIn" in detail.user) && detail.tracks.length === 2);
  }

  console.log("--- decisions ---");
  const trackA = (await prisma.applicationTrack.findFirstOrThrow({ where: { applicationId: d1.id, track: "media" } })).id;
  const trackB = (await prisma.applicationTrack.findFirstOrThrow({ where: { applicationId: d1.id, track: NO_INTERVIEW_TEAM } })).id;
  await expectError("an officer can't decide their own application", () => setTrackStatus(u1.id, trackA, "ACCEPTED", "ANY"), "SELF_REVIEW");
  await expectError("Interview is refused for a team without interviews", () => setTrackStatus(officer.id, trackB, "INTERVIEW", "ANY"), "INTERVIEW_NOT_OFFERED");
  await expectError("an officer can't set SUBMITTED", () => setTrackStatus(officer.id, trackA, "SUBMITTED", "ANY"), "BAD_STATUS");
  await expectError("unknown id", () => setTrackStatus(officer.id, "does-not-exist", "ACCEPTED", "ANY"), "NOT_FOUND");
  {
    const r = await setTrackStatus(officer.id, trackA, "INTERVIEW", "ANY");
    check("Interview works for a team that interviews", r.status === "INTERVIEW" && r.previousStatus === "SUBMITTED" && r.applicantUserId === u1.id);
    const row = await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackA } });
    check("decision time and officer are recorded", !!row.decidedAt && row.decidedById === officer.id);
    await expectError("same status twice is rejected", () => setTrackStatus(officer.id, trackA, "INTERVIEW", "ANY"), "BAD_STATUS");
    await setTrackStatus(officer.id, trackB, "REJECTED", "ANY");
    check("the two teams are decided independently", (await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackB } })).status === "REJECTED" && (await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackA } })).status === "INTERVIEW");
    const audits = await prisma.auditLog.count({ where: { entityType: "APPLICATION_TRACK", entityId: { in: [trackA, trackB] }, actionType: "APPLICATION_TRACK_STATUS_CHANGED" } });
    check("each change wrote an audit entry", audits === 2, `audits=${audits}`);
    await setTrackStatus(officer.id, trackA, "IN_REVIEW", "ANY");
    const back = await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackA } });
    check("moving back to In review clears the decision", back.status === "IN_REVIEW" && back.decidedAt === null && back.decidedById === null);
  }

  console.log("--- booking link visibility ---");
  {
    await prisma.recruitingTrackConfig.upsert({
      where: { cycleId_track: { cycleId: cycle.id, track: "media" } },
      create: { cycleId: cycle.id, track: "media", schedulingUrl: "https://calendar.app.google/example" },
      update: { schedulingUrl: "https://calendar.app.google/example" },
    });
    const ta = (await getApplicantStatus(u1.id, IN)).application!.tracks.find((t) => t.track === "media")!;
    check("no booking link unless the team has invited them", ta.bookingUrl === null);
    await setTrackStatus(officer.id, trackA, "INTERVIEW", "ANY");
    const ta2 = (await getApplicantStatus(u1.id, IN)).application!.tracks.find((t) => t.track === "media")!;
    check("booking link appears once invited to interview", ta2.bookingUrl === "https://calendar.app.google/example");
    await setTrackStatus(officer.id, trackA, "ACCEPTED", "ANY");
    const ta3 = (await getApplicantStatus(u1.id, IN)).application!.tracks.find((t) => t.track === "media")!;
    check("...and disappears after a final decision", ta3.bookingUrl === null);
  }

  console.log("--- reviews ---");
  await expectError("score 6 rejected", () => addReview(officer.id, trackA, { score: 6 }), "INVALID");
  await expectError("empty review rejected", () => addReview(officer.id, trackA, {}), "INVALID");
  await expectError("whitespace-only note rejected", () => addReview(officer.id, trackA, { notes: "   " }), "INVALID");
  await expectError("unknown field rejected", () => addReview(officer.id, trackA, { score: 3, reviewerId: u2.id }), "INVALID");
  await expectError("an officer can't review their own application", () => addReview(u1.id, trackA, { score: 5 }), "SELF_REVIEW");
  {
    const r = await addReview(officer.id, trackA, { score: 4, notes: "  strong  " });
    check("valid review saved, note trimmed", r.score === 4 && r.notes === "strong" && r.reviewerId === officer.id);
    await addReview(officer.id, trackA, { notes: "note only" });
    const list = await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: run, track: "media" });
    const row = list.rows.find((x) => x.application.userId === u1.id)!;
    check("list shows review count and average score", row.reviewCount === 2 && row.averageScore === 4, `${row.reviewCount} / ${row.averageScore}`);
  }
  {
    const draftTrack = await prisma.applicationTrack.create({ data: { applicationId: (await getOrCreateDraft(u2.id, IN)).id, track: NO_INTERVIEW_TEAM } });
    await expectError("can't review a draft's team", () => addReview(officer.id, draftTrack.id, { score: 3 }), "NOT_FOUND");
    await expectError("can't decide a draft's team", () => setTrackStatus(officer.id, draftTrack.id, "IN_REVIEW", "ANY"), "NOT_FOUND");
  }

  console.log("--- email (no real mail is sent: RESEND_API_KEY is cleared) ---");
  {
    check("the API key is cleared, so nothing can really send", process.env.RESEND_API_KEY === "");
    const label = (key: string) => tracks.find((t) => t.key === key)!.label;
    const u4 = await makeUser("u4");
    await setSelectedTracks(u4.id, ["media", NO_INTERVIEW_TEAM], IN);
    await saveDraft(u4.id, { genericAnswers: GENERIC, resumeUrl: RESUME, trackAnswers: { "media": MEDIA_FULL } }, IN);

    // -- the confirmation email, queued by the submission itself
    const submitted = await submitAndNotify(u4.id, IN);
    const app4 = await prisma.application.findFirstOrThrow({ where: { userId: u4.id }, include: { tracks: true, emails: true } });
    check("submitting queues exactly one confirmation email", app4.state === "SUBMITTED" && app4.emails.length === 1, `emails=${app4.emails.length}`);
    const received = app4.emails[0];
    check("it is the application-level RECEIVED email, addressed to the ACCOUNT email", received.template === "RECEIVED" && received.applicationTrackId === null && received.toEmail === u4.email);
    check("it lists every team applied to", received.body.includes(label("media")) && received.body.includes(label(NO_INTERVIEW_TEAM)));
    check("delivery was attempted and honestly recorded as FAILED, and the submission is unaffected", submitted.delivery?.status === "FAILED" && received.status === "FAILED" && /not configured/i.test(received.error ?? ""), `${received.status} ${received.error}`);
    await expectError("submitting again is refused", () => submitAndNotify(u4.id, IN), "ALREADY_SUBMITTED");
    check("...and queued no second confirmation", (await prisma.applicationEmail.count({ where: { applicationId: app4.id } })) === 1);

    const tA = app4.tracks.find((t) => t.track === "media")!.id;
    const tB = app4.tracks.find((t) => t.track === NO_INTERVIEW_TEAM)!.id;
    const emailCount = (trackId: string) => prisma.applicationEmail.count({ where: { applicationTrackId: trackId } });

    // -- decision emails (media has a booking link from the section above)
    const d1 = await decideAndNotify(officer.id, tA, "INTERVIEW", { expectedStatus: "ANY", sendEmail: true });
    const interviewMail = await prisma.applicationEmail.findUniqueOrThrow({ where: { id: d1.emailId! } });
    check("a decision with 'send email' changes the status and queues one email together", d1.status === "INTERVIEW" && !!d1.emailId && (await emailCount(tA)) === 1);
    check("the interview email names the team, goes to the account address, and uses the booking link", interviewMail.template === "INTERVIEW" && interviewMail.applicationTrackId === tA && interviewMail.toEmail === u4.email && interviewMail.subject.includes(label("media")) && interviewMail.body.includes("https://calendar.app.google/example"), JSON.stringify({ subject: interviewMail.subject }));
    check("a failed send is recorded on the row, and the decision stands", d1.delivery?.status === "FAILED" && interviewMail.status === "FAILED" && (await prisma.applicationTrack.findUniqueOrThrow({ where: { id: tA } })).status === "INTERVIEW");

    // -- the transaction really rolls back when the email can't be built
    await setTrackStatus(officer.id, tA, "IN_REVIEW", "ANY");
    await prisma.recruitingTrackConfig.deleteMany({ where: { cycleId: cycle.id, track: "media" } });
    const before = await emailCount(tA);
    await expectError("an email that needs a missing booking link is refused", () => decideAndNotify(officer.id, tA, "INTERVIEW", { expectedStatus: "ANY", sendEmail: true, override: { subject: "Hi", body: "Book here: {{schedulingLink}}" } }), "MISSING_SCHEDULING_LINK");
    const afterFail = await prisma.applicationTrack.findUniqueOrThrow({ where: { id: tA } });
    check("...and the status change was rolled back with it", afterFail.status === "IN_REVIEW" && afterFail.decidedAt === null, `status=${afterFail.status}`);
    check("...and no email row was left behind", (await emailCount(tA)) === before);
    await expectError("an unknown placeholder is refused", () => decideAndNotify(officer.id, tA, "ACCEPTED", { expectedStatus: "ANY", sendEmail: true, override: { subject: "Hi", body: "Dear {{applicnatName}}" } }), "INVALID");
    check("...also with no status change", (await prisma.applicationTrack.findUniqueOrThrow({ where: { id: tA } })).status === "IN_REVIEW");
    const d2 = await decideAndNotify(officer.id, tA, "INTERVIEW", { expectedStatus: "ANY", sendEmail: true });
    const noLinkMail = await prisma.applicationEmail.findUniqueOrThrow({ where: { id: d2.emailId! } });
    check("with no booking link configured the default interview email asks them to reply instead", noLinkMail.body.includes("Reply to this email") && !noLinkMail.body.includes("https://"), noLinkMail.body.slice(0, 160));

    // -- rules around who gets what
    const bBefore = await emailCount(tB);
    await expectError("Interview + email for a team without interviews is refused", () => decideAndNotify(officer.id, tB, "INTERVIEW", { expectedStatus: "ANY", sendEmail: true }), "INTERVIEW_NOT_OFFERED");
    await expectError("an officer can't decide their own application, with or without email", () => decideAndNotify(u4.id, tB, "ACCEPTED", { expectedStatus: "ANY", sendEmail: true }), "SELF_REVIEW");
    await expectError("'send email' on a status that has no email is refused", () => decideAndNotify(officer.id, tB, "IN_REVIEW", { expectedStatus: "ANY", sendEmail: true }), "BAD_STATUS");
    check("none of those left an email row", (await emailCount(tB)) === bBefore);
    const d3 = await decideAndNotify(officer.id, tB, "REJECTED", { expectedStatus: "ANY", sendEmail: false });
    check("a decision without 'send email' queues nothing", d3.emailId === null && d3.delivery === null && (await emailCount(tB)) === bBefore);

    const d4 = await decideAndNotify(officer.id, tB, "ACCEPTED", { expectedStatus: "ANY", sendEmail: true, override: { subject: "Custom for {{applicantName}}", body: "Edited note." } });
    const edited = await prisma.applicationEmail.findUniqueOrThrow({ where: { id: d4.emailId! } });
    check("the officer's edited wording is what is stored (placeholders filled)", edited.subject === `Custom for ${u4.displayName}` && edited.body === "Edited note.", `${edited.subject} | ${edited.body}`);

    await prisma.application.update({ where: { id: app4.id }, data: { email: "attacker@evil.test" } });
    const d5 = await decideAndNotify(officer.id, tB, "REJECTED", { expectedStatus: "ANY", sendEmail: true });
    const toMail = await prisma.applicationEmail.findUniqueOrThrow({ where: { id: d5.emailId! } });
    check("mail goes to the account email even if the application's copy was changed", toMail.toEmail === u4.email, toMail.toEmail);

    const rowsBeforePreview = await prisma.applicationEmail.count({ where: { applicationId: app4.id } });
    const preview = await previewDecisionEmail(tB, "ACCEPTED");
    check("previewing shows the final text and HTML and writes nothing", !!preview && preview.subject.includes(label(NO_INTERVIEW_TEAM)) && preview.html.includes("<html") && (await prisma.applicationEmail.count({ where: { applicationId: app4.id } })) === rowsBeforePreview);
    check("a status with no email has no preview", (await previewDecisionEmail(tB, "IN_REVIEW")) === null);
    const draftId = (await getMyApplication(u2.id))!.id;
    const draftTrackId = (await prisma.applicationTrack.create({ data: { applicationId: draftId, track: "competition" } })).id;
    await expectError("a draft application can't be emailed or previewed", () => composeTrackEmail(prisma, draftTrackId, "ACCEPTED"), "NOT_FOUND");

    // -- resend and cleanup of stuck mail
    const r1 = await resendEmail(officer.id, interviewMail.id);
    check("resending a failed email tries again and records the new outcome", r1.status === "FAILED" && (await prisma.applicationEmail.findUniqueOrThrow({ where: { id: interviewMail.id } })).status === "FAILED");
    check("...and writes an audit entry", (await prisma.auditLog.count({ where: { entityType: "APPLICATION_EMAIL", entityId: interviewMail.id, actionType: "APPLICATION_EMAIL_RESENT" } })) === 1);
    await prisma.applicationEmail.update({ where: { id: interviewMail.id }, data: { status: "SENT" } });
    await expectError("an email already SENT can't be resent", () => resendEmail(officer.id, interviewMail.id), "BAD_STATUS");
    await expectError("an unknown email id", () => resendEmail(officer.id, "does-not-exist"), "NOT_FOUND");

    const stuck = await prisma.applicationEmail.create({ data: { applicationId: app4.id, template: "ACCEPTED", toEmail: u4.email, subject: "x", body: "y", status: "PENDING", createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const fresh = await prisma.applicationEmail.create({ data: { applicationId: app4.id, template: "ACCEPTED", toEmail: u4.email, subject: "x", body: "y", status: "PENDING" } });
    const flipped = await failInterruptedEmails();
    check("an email stuck PENDING for an hour is turned into FAILED", flipped >= 1 && (await prisma.applicationEmail.findUniqueOrThrow({ where: { id: stuck.id } })).status === "FAILED");
    check("...but a brand-new PENDING one is left alone", (await prisma.applicationEmail.findUniqueOrThrow({ where: { id: fresh.id } })).status === "PENDING");
    const attention = await listEmailsNeedingAttention(cycle.id);
    check("the 'needs attention' list shows this applicant's failed and pending mail", attention.some((e) => e.id === stuck.id) && attention.some((e) => e.id === fresh.id) && !attention.some((e) => e.id === interviewMail.id));
    // The sweep retries mail that has been PENDING for a couple of minutes; don't let this one skew its counts later
    await prisma.applicationEmail.delete({ where: { id: fresh.id } });
  }

  console.log("--- a draft left unsubmitted after the deadline ---");
  {
    const v = await getApplicantStatus(u2.id, AFTER);
    check("it is shown as expired, not submitted", v.application?.expiredUnsubmitted === true && v.application.state === "DRAFT" && v.round?.window === "closed");
  }

  console.log("--- export (real database) ---");
  {
    const u4 = await prisma.user.findUniqueOrThrow({ where: { id: `${run}-u4` } }); // created in the email section above
    await prisma.application.update({ where: { id: d1.id }, data: { fullName: '=HYPERLINK("http://evil.test","click")' } });
    const all = await exportRound(officer.id, "fall-2026", { q: run }, { adminBaseUrl: "https://example.test/" });
    const lines = all ? all.csv.replace(/^\uFEFF/, "").trim().split("\r\n") : [];
    check("starts with a byte-order mark and one header line", !!all && all.csv.charCodeAt(0) === 0xfeff && lines.length >= 1);
    check("one row per submitted team application (3 applicants x 2 teams), drafts excluded", !!all && all.rowCount === 6 && lines.length === 7, `rowCount=${all?.rowCount} lines=${lines.length}`);
    check("the draft applicant is not in the file", !!all && !all.csv.includes(`Test u2`));
    check("a formula in the applicant's name is neutralized", !!all && all.csv.includes(`"'=HYPERLINK(""http://evil.test"",""click"")"`), all?.csv.slice(0, 300));
    check("the ACCOUNT email is exported, not the altered copy on the application", !!all && all.csv.includes(u4.email) && !all.csv.includes("attacker@evil.test"));
    check("rows link to the application in the admin area", !!all && all.csv.includes(`https://example.test/admin/recruiting/${d1.id}`));
    // Regression: the list used to search and show the email COPIED onto the application, which can differ from the account email
    const byAccountEmail = await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: u4.email });
    check("the list finds an applicant by their account email even when the application's copy differs", byAccountEmail.rows.length === 2 && byAccountEmail.rows.every((r) => r.application.email === u4.email), `rows=${byAccountEmail.rows.length}`);
    check("...and never by the altered copy being shown", (await listTrackApplications({ viewerId: null, cycleId: cycle.id, q: "attacker@evil.test" })).rows.every((r) => r.application.email !== "attacker@evil.test"));
    const onlyA = await exportRound(officer.id, "fall-2026", { q: run, track: "media" }, { adminBaseUrl: "https://example.test" });
    check("filters apply to the export", !!onlyA && onlyA.rowCount === 2 && !onlyA.csv.includes("Test team (no interview)"), `rowCount=${onlyA?.rowCount}`);
    check("an unknown round exports nothing", (await exportRound(officer.id, "no-such-round", {}, { adminBaseUrl: "https://example.test" })) === null);
    const audits = await prisma.auditLog.count({ where: { entityType: "RECRUITING_CYCLE", entityId: cycle.id, actionType: "RECRUITING_EXPORTED", actorUserId: officer.id } });
    check("each export is audit-logged", audits >= 2, `audits=${audits}`);
    await recordApplicationViewed(officer.id, d1.id, u1.id);
    check("opening an application is audit-logged", (await prisma.auditLog.count({ where: { entityType: "APPLICATION", entityId: d1.id, actionType: "APPLICATION_VIEWED" } })) === 1);
  }

  console.log("--- bulk decisions and the daily email limit ---");
  {
    const u5 = await makeUser("u5");
    await setSelectedTracks(u5.id, ["media", NO_INTERVIEW_TEAM], IN).catch(() => null);
    // u5 needs its own complete application: it can only be started while a round is active (fall-2026 is)
    await saveDraft(u5.id, { genericAnswers: GENERIC, resumeUrl: RESUME, trackAnswers: { "media": MEDIA_FULL } }, IN);
    await submitAndNotify(u5.id, IN);
    const app5 = await prisma.application.findFirstOrThrow({ where: { userId: u5.id }, include: { tracks: true } });
    const t5a = app5.tracks.find((t) => t.track === "media")!.id;
    const t5b = app5.tracks.find((t) => t.track === NO_INTERVIEW_TEAM)!.id;
    const originalLimit = process.env.RESEND_DAILY_LIMIT;
    try {
      // 10 of the day's emails are held back for receipts, so a limit of 11 leaves exactly 1
      process.env.RESEND_DAILY_LIMIT = "11";
      const quota = await getEmailQuota();
      check("the quota counts recruiting mail and reads the plan's limit, holding the receipts headroom back", quota.dailyLimit === 11 && quota.left === 1 && quota.sentToday === 0, JSON.stringify(quota));
      await expectError("a batch bigger than what's left of today's limit is refused up front", () => bulkDecide(officer.id, [t5a, t5b], "ACCEPTED", { expectedStatuses: anyOf([t5a, t5b]), sendEmail: true }), "EMAIL_LIMIT");
      const untouched = await prisma.applicationTrack.findMany({ where: { applicationId: app5.id }, select: { status: true } });
      check("...and nobody was decided", untouched.every((t) => t.status === "SUBMITTED"), JSON.stringify(untouched));
      const forced = await bulkDecide(officer.id, [t5a, t5b], "ACCEPTED", { expectedStatuses: anyOf([t5a, t5b]), sendEmail: true, ignoreLimit: true });
      check("'send anyway' decides them, with their emails failing honestly (no key)", forced.decided === 2 && forced.emailsFailed === 2 && forced.emailsSent === 0, JSON.stringify(forced));
    } finally {
      if (originalLimit === undefined) delete process.env.RESEND_DAILY_LIMIT;
      else process.env.RESEND_DAILY_LIMIT = originalLimit;
    }
    const mixed = await bulkDecide(officer.id, [t5a, "no-such-application", t5b], "IN_REVIEW", { expectedStatuses: anyOf([t5a, "no-such-application", t5b]), sendEmail: false });
    check("a bulk change carries on past one it can't make, and says why", mixed.decided === 2 && mixed.failures.length === 1 && mixed.failures[0].applicationTrackId === "no-such-application", JSON.stringify(mixed));
    const interview = await bulkDecide(officer.id, [t5b], "INTERVIEW", { expectedStatuses: anyOf([t5b]), sendEmail: false });
    check("Interview is refused per team inside a bulk change", interview.decided === 0 && /does not run interviews/.test(interview.failures[0]?.error ?? ""), JSON.stringify(interview));
    const own = await bulkDecide(u5.id, [t5a], "ACCEPTED", { expectedStatuses: anyOf([t5a]), sendEmail: false });
    check("an officer can't bulk-decide their own application", own.decided === 0 && own.failures.length === 1);
  }

  console.log("--- rounds, booking links, resend-all (real database) ---");
  const seeded = cycle.id;
  const roundSlug = (n: string) => `t6-${run}-${n}`;
  try {
    const a = await createCycle(officer.id, { name: `T6 ${run} A`, slug: roundSlug("a"), opensAt: new Date("2027-01-01T06:00:00Z"), closesAt: new Date("2027-02-01T06:00:00Z") });
    check("a new round starts inactive at the current form version", a.isActive === false && a.formVersion >= 1);
    await expectError("an address already in use is refused with a field message", () => createCycle(officer.id, { name: "again", slug: roundSlug("a"), opensAt: new Date("2027-03-01T06:00:00Z"), closesAt: new Date("2027-04-01T06:00:00Z") }), "INVALID", (e) => "slug" in (e.fieldErrors ?? {}));
    await expectError("a round that closes before it opens is refused", () => createCycle(officer.id, { name: "bad", slug: roundSlug("bad"), opensAt: new Date("2027-04-01T06:00:00Z"), closesAt: new Date("2027-03-01T06:00:00Z") }), "INVALID");
    await expectError("an uppercase address is refused", () => createCycle(officer.id, { name: "bad", slug: "Not-OK", opensAt: new Date("2027-03-01T06:00:00Z"), closesAt: new Date("2027-04-01T06:00:00Z") }), "INVALID");

    await saveTrackConfig(officer.id, a.id, "media", "https://calendar.app.google/t6-copy-me");
    check("a booking link is saved for a team that interviews", (await getTrackConfigs(a.id))["media"] === "https://calendar.app.google/t6-copy-me");
    await expectError("a team without interviews can't have a booking link", () => saveTrackConfig(officer.id, a.id, NO_INTERVIEW_TEAM, "https://calendar.app.google/x"), "INVALID");
    await expectError("a non-Google host is refused by default", () => saveTrackConfig(officer.id, a.id, "media", "https://calendly.com/lsr/x"), "INVALID");
    await expectError("a plain http link is refused", () => saveTrackConfig(officer.id, a.id, "media", "http://calendar.app.google/x", { allowOtherHost: true }), "INVALID");
    await saveTrackConfig(officer.id, a.id, "media", "https://calendly.com/lsr/x", { allowOtherHost: true });
    check("...unless the officer allows another host", (await getTrackConfigs(a.id))["media"] === "https://calendly.com/lsr/x");
    await saveTrackConfig(officer.id, a.id, "media", "https://calendar.app.google/t6-copy-me");
    check("every link change is audit-logged with before and after", (await prisma.auditLog.count({ where: { entityId: a.id, actionType: "RECRUITING_BOOKING_LINK_CHANGED" } })) === 3);

    const b = await createCycle(officer.id, { name: `T6 ${run} B`, slug: roundSlug("b"), opensAt: new Date("2027-03-01T06:00:00Z"), closesAt: new Date("2027-04-01T06:00:00Z") });
    check("a new round copies the previous round's booking links", b.copiedLinks === 1 && (await getTrackConfigs(b.id))["media"] === "https://calendar.app.google/t6-copy-me", `copied=${b.copiedLinks}`);

    await setActiveCycle(officer.id, a.id);
    const active = await prisma.recruitingCycle.findMany({ where: { isActive: true }, select: { id: true } });
    check("activating a round switches the previous one off (exactly one active)", active.length === 1 && active[0].id === a.id, JSON.stringify(active));
    check("applicants now see the new active round", (await getActiveRound())?.id === a.id);
    let rawError = "";
    try {
      await prisma.recruitingCycle.update({ where: { id: seeded }, data: { isActive: true } });
    } catch (e) {
      rawError = e instanceof Error ? e.message : String(e);
    }
    check("the database itself refuses a second active round", /Unique constraint|single_active/i.test(rawError), rawError.slice(0, 120));
    await setActiveCycle(officer.id, null);
    check("turning recruiting off leaves no active round", (await prisma.recruitingCycle.count({ where: { isActive: true } })) === 0);
    await expectError("a missing round can't be activated", () => setActiveCycle(officer.id, "no-such-round"), "NOT_FOUND");
    check("...and that did not turn anything off", (await prisma.recruitingCycle.count({ where: { isActive: true } })) === 0);
    await setActiveCycle(officer.id, seeded);
    check("the seeded round is active again", (await getActiveRound())?.slug === "fall-2026");

    const renamed = await updateCycle(officer.id, a.id, { name: `T6 ${run} A (renamed)`, opensAt: new Date("2027-01-02T06:00:00Z"), closesAt: new Date("2027-02-02T06:00:00Z") });
    check("renaming and re-dating a round keeps its address", renamed.slug === roundSlug("a") && renamed.name.endsWith("(renamed)"));

    // resend-all, isolated in round A: three failed emails on one submitted application
    const u6 = await makeUser("u6");
    const appA = await prisma.application.create({ data: { cycleId: a.id, userId: u6.id, formVersion: a.formVersion, state: "SUBMITTED", submittedAt: new Date(), fullName: "Test u6", email: u6.email } });
    const failedMail = () => ({ applicationId: appA.id, template: "RECEIVED", toEmail: u6.email, subject: "s", body: "b", status: "FAILED" as const, error: "Daily quota exceeded" });
    await prisma.applicationEmail.createMany({ data: [failedMail(), failedMail(), failedMail()] });
    check("the 'needs attention' count covers failed mail in the round", (await countEmailsNeedingAttention(a.id)) === 3);
    const originalLimit2 = process.env.RESEND_DAILY_LIMIT;
    try {
      process.env.RESEND_DAILY_LIMIT = "2";
      await expectError("'resend all' won't start a batch bigger than what's left today", () => resendAllFailed(officer.id, a.id), "EMAIL_LIMIT");
      const forced = await resendAllFailed(officer.id, a.id, { ignoreLimit: true });
      check("'resend all' with 'send anyway' tries every failed email in that round only", forced.total === 3 && forced.sent === 0 && forced.failed === 3, JSON.stringify(forced));
    } finally {
      if (originalLimit2 === undefined) delete process.env.RESEND_DAILY_LIMIT;
      else process.env.RESEND_DAILY_LIMIT = originalLimit2;
    }
    check("...and each attempt is audit-logged", (await prisma.auditLog.count({ where: { entityType: "APPLICATION_EMAIL", actionType: "APPLICATION_EMAIL_RESENT", targetUserId: u6.id } })) === 3);
    check("nothing was lost: still 3 failed emails to resend later", (await listEmailsNeedingAttention(a.id)).filter((e) => e.status === "FAILED").length === 3);

    check("round list shows submitted counts", (await listCycles()).find((c) => c.id === a.id)?.submitted === 1);
    await expectError("a round with applications can't be deleted", () => deleteCycle(officer.id, a.id), "BAD_STATUS");
    await expectError("the active round can't be deleted", () => deleteCycle(officer.id, seeded), "BAD_STATUS");
    await deleteCycle(officer.id, b.id);
    check("an unused inactive round can be deleted", (await prisma.recruitingCycle.count({ where: { id: b.id } })) === 0);
  } finally {
    // Leave the seeded round active no matter what happened above
    await prisma.recruitingCycle.updateMany({ where: { isActive: true, id: { not: seeded } }, data: { isActive: false } });
    await prisma.recruitingCycle.update({ where: { id: seeded }, data: { isActive: true } });
  }

  console.log("--- the real teams: Technology and Community ---");
  {
    const u = await makeUser("real");
    await getOrCreateDraft(u.id, IN);
    await setSelectedTracks(u.id, ["technology", "community"], IN);
    await expectError("a Technology hours answer that isn't an option is rejected", () => saveDraft(u.id, { trackAnswers: { technology: { tech_hours: "2 hours" } } }, IN), "INVALID");
    await expectError("an empty set of checkboxes can't be submitted (Technology areas are required)", async () => {
      await saveDraft(u.id, { resumeUrl: RESUME, trackAnswers: { technology: { tech_areas: [], tech_experience: "Classes or tutorials", tech_built: "A stats site", tech_hours: "3–5" }, community: { comm_interest: ["Formula 1"], comm_why: "w", comm_organized: "o", comm_event: "e", comm_hours: "1–3" } } }, IN);
      await submitApplication(u.id, IN);
    }, "INCOMPLETE", (e) => e.report?.sections.some((x) => x.key === "track:technology" && !x.complete) === true);
    await saveDraft(u.id, { trackAnswers: { technology: { tech_areas: ["UI/UX design", "Race data and stats (results, live timing)"], tech_link: "https://github.com/example" } } }, IN);
    const done = await submitApplication(u.id, IN);
    check("both real teams submit together with their answers", done.tracks.sort().join() === "community,technology");
    const saved = await prisma.applicationTrack.findMany({ where: { applicationId: done.applicationId }, orderBy: { track: "asc" } });
    const tech = saved.find((t) => t.track === "technology")?.answers as Record<string, unknown>;
    check("the multiple-choice answers were stored as lists", Array.isArray(tech.tech_areas) && (tech.tech_areas as string[]).length === 2 && tech.tech_hours === "3–5", JSON.stringify(tech));
  }

  console.log("--- deadline sweep ---");
  {
    const sw = await prisma.recruitingCycle.create({
      data: { slug: `t8-${run}`, name: `T8 ${run}`, opensAt: new Date("2026-01-01T06:00:00Z"), closesAt: new Date("2026-02-01T06:00:00Z") },
    });
    const draft = async (label: string, opts: { resume?: boolean; teams?: string[]; submitted?: boolean } = {}) => {
      const u = await makeUser(label);
      const app = await prisma.application.create({
        data: {
          cycleId: sw.id,
          userId: u.id,
          formVersion: sw.formVersion,
          state: opts.submitted ? "SUBMITTED" : "DRAFT",
          submittedAt: opts.submitted ? new Date("2026-01-20T12:00:00Z") : null,
          fullName: `Test ${label}`,
          email: u.email,
          eid: u.eid,
          gradYear: 2028,
          major: "Testing",
          resumeUrl: opts.resume === false ? null : RESUME,
          genericAnswers: GENERIC,
          tracks: { create: (opts.teams ?? [NO_INTERVIEW_TEAM]).map((track) => ({ track, answers: {} })) },
        },
      });
      return { u, app };
    };
    const complete1 = await draft("sw1");
    const complete2 = await draft("sw2");
    const noResume = await draft("sw3", { resume: false });
    const noTeams = await draft("sw4", { teams: [] });
    const already = await draft("sw5", { submitted: true });
    const stateOf = (id: string) => prisma.application.findUniqueOrThrow({ where: { id }, include: { tracks: true } });
    const emailsFor = (id: string) => prisma.applicationEmail.findMany({ where: { applicationId: id } });

    const early = await sweepCycle(sw.id, new Date("2026-01-15T12:00:00Z"));
    check("before the deadline the sweep does nothing", !early.ran && early.submitted === 0 && (await stateOf(complete1.app.id)).state === "DRAFT");
    const openRound = await sweepCycle(cycle.id, IN);
    check("an open round is never swept", !openRound.ran && openRound.checked === 0);

    const first = await sweepAndNotify({ cycleId: sw.id });
    check("complete drafts are submitted, the rest are left alone", first.submitted === 2 && first.skippedIncomplete === 1 && first.skippedNoTeams === 1 && first.failed === 0, JSON.stringify(first));
    const c1 = await stateOf(complete1.app.id);
    check("auto-submitted: state, flag, and submittedAt = the deadline", c1.state === "SUBMITTED" && c1.autoSubmitted && c1.submittedAt?.getTime() === sw.closesAt.getTime(), `${c1.state} ${c1.autoSubmitted} ${c1.submittedAt?.toISOString()}`);
    check("...and its teams are submitted too", c1.tracks.length === 1 && c1.tracks.every((t) => t.status === "SUBMITTED"));
    check("an incomplete draft stays a draft, never submitted", (await stateOf(noResume.app.id)).state === "DRAFT" && (await emailsFor(noResume.app.id)).length === 0);
    check("a draft with no team stays a draft", (await stateOf(noTeams.app.id)).state === "DRAFT");
    const alreadyRow = await stateOf(already.app.id);
    check("an application the applicant already submitted is untouched", alreadyRow.state === "SUBMITTED" && !alreadyRow.autoSubmitted && alreadyRow.submittedAt?.toISOString() === "2026-01-20T12:00:00.000Z");
    const mail1 = await emailsFor(complete1.app.id);
    check("exactly one confirmation, to the account email", mail1.length === 1 && mail1[0].template === "RECEIVED" && mail1[0].toEmail === complete1.u.email, JSON.stringify(mail1.map((m) => m.toEmail)));
    check("no real mail went out (no API key), so the confirmations show as failed for resend", first.emailsSent === 0 && first.emailsFailed === 2, JSON.stringify(first));
    check("each auto-submit is audit-logged with no acting user", (await prisma.auditLog.count({ where: { actionType: "APPLICATION_AUTO_SUBMITTED", actorUserId: null, targetUserId: { in: [complete1.u.id, complete2.u.id] } } })) === 2);

    const second = await sweepAndNotify({ cycleId: sw.id });
    check("running it again changes nothing", second.submitted === 0 && (await emailsFor(complete1.app.id)).length === 1 && (await emailsFor(complete2.app.id)).length === 1, JSON.stringify(second));

    const racer = await draft("sw6");
    const [r1, r2] = await Promise.all([sweepAndNotify({ cycleId: sw.id }), sweepAndNotify({ cycleId: sw.id })]);
    check("two sweeps at once submit it exactly once, with exactly one email", r1.submitted + r2.submitted === 1 && (await emailsFor(racer.app.id)).length === 1, `${r1.submitted}+${r2.submitted} emails=${(await emailsFor(racer.app.id)).length}`);

    await expectError("applicants still can't write after the deadline", () => saveDraft(noResume.u.id, { resumeUrl: RESUME }, AFTER), "ROUND_CLOSED");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
}

/** For checks that exercise something else: skip the stale-status guard on purpose */
const anyOf = (ids: string[]) => Object.fromEntries(ids.map((i) => [i, "ANY" as const]));

async function cleanup() {
  const apps = await prisma.application.findMany({ where: { userId: { in: userIds } }, select: { id: true, tracks: { select: { id: true } } } });
  const entityIds = apps.flatMap((a) => [a.id, ...a.tracks.map((t) => t.id)]);
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: entityIds } }, { actorUserId: { in: userIds } }, { targetUserId: { in: userIds } }] } });
  await prisma.recruitingTrackConfig.deleteMany({ where: { schedulingUrl: "https://calendar.app.google/example" } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // cascades applications, teams, reviews, emails
  await prisma.recruitingCycle.deleteMany({ where: { slug: `t8-${run}` } });
  await prisma.recruitingCycle.deleteMany({ where: { slug: { startsWith: `t6-${run}` } } }); // their booking links go with them
  await prisma.recruitingCycle.updateMany({ where: { slug: "fall-2026" }, data: { isActive: true } });
  const left = await prisma.user.count({ where: { id: { in: userIds } } });
  console.log(`cleanup: ${userIds.length} test users removed (${left} left)`);
}

main()
  .catch((e) => {
    fail++;
    console.error("Script crashed:", e);
  })
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
      process.exit(fail ? 1 : 0);
    }
  });
