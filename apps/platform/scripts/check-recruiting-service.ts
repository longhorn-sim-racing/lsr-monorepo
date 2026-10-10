// Integration check for src/server/services/recruiting.service.ts against the LOCAL database.
// There is no test runner and CI has no database, so run this by hand after changing the
// recruiting service or schema:
//
//   cd apps/platform
//   NODE_ENV=production npx tsx scripts/check-recruiting-service.ts
//
// (NODE_ENV=production only quiets Prisma's per-query logging.) It needs `npx supabase start`,
// a migrated + seeded database (`pnpm db:reset`: it uses the seeded active round `fall-2026`),
// and it refuses to run unless DATABASE_URL points at localhost. It creates its own users and
// deletes everything it created when it finishes, pass or fail.

import { prisma } from "../src/server/db";
import {
  RecruitingError,
  addReview,
  getApplicantStatus,
  getApplicationDetail,
  getMyApplication,
  getOrCreateDraft,
  listTrackApplications,
  saveDraft,
  setSelectedTracks,
  setTrackStatus,
  submitApplication,
  type RecruitingErrorCode,
} from "../src/server/services/recruiting.service";

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
const GENERIC = { why_join: "Because", sim_experience: 3 };
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
  await saveDraft(u1.id, { step: "general", profile: { major: "Math" }, genericAnswers: { why_join: "  Love racing  " } }, IN);
  await saveDraft(u1.id, { genericAnswers: { sim_experience: 3 } }, IN);
  {
    const a = await getMyApplication(u1.id);
    const g = a?.genericAnswers as Record<string, unknown>;
    check("pages merge instead of overwriting", g.why_join === "Love racing" && g.sim_experience === 3, JSON.stringify(g));
    check("text is trimmed and the step is remembered", a?.draftStep === "general" && a.major === "Math");
  }
  await saveDraft(u1.id, { genericAnswers: { why_join: "" } }, IN);
  check("clearing a field removes it", !("why_join" in ((await getMyApplication(u1.id))?.genericAnswers as Record<string, unknown>)));
  await expectError("unknown question id rejected", () => saveDraft(u1.id, { genericAnswers: { nope: "x" } }, IN), "INVALID");
  await expectError("scale out of range rejected", () => saveDraft(u1.id, { genericAnswers: { sim_experience: 9 } }, IN), "INVALID");
  await expectError("answers for a team that isn't chosen rejected", () => saveDraft(u1.id, { trackAnswers: { "team-a": { a_experience: "x" } } }, IN), "INVALID");
  await expectError("http resume link rejected", () => saveDraft(u1.id, { resumeUrl: "http://example.com/r.pdf" }, IN), "INVALID");
  await expectError("6 portfolio links rejected", () => saveDraft(u1.id, { portfolioLinks: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: "https://example.com" })) }, IN), "INVALID");
  {
    // all-or-nothing: one valid change + one invalid change writes nothing
    const before = await getMyApplication(u1.id);
    await expectError("a bad answer rejects the whole save", () => saveDraft(u1.id, { profile: { major: "Chemistry" }, genericAnswers: { sim_experience: 99 } }, IN), "INVALID");
    const after = await getMyApplication(u1.id);
    check("...and nothing from it was written", after?.major === before?.major, `${before?.major} -> ${after?.major}`);
  }

  console.log("--- choosing teams ---");
  await expectError("unknown team rejected", () => setSelectedTracks(u1.id, ["nope"], IN), "INVALID");
  await expectError("duplicate team rejected", () => setSelectedTracks(u1.id, ["team-a", "team-a"], IN), "INVALID");
  await expectError("non-array rejected", () => setSelectedTracks(u1.id, "team-a", IN), "INVALID");
  {
    const r = await setSelectedTracks(u1.id, ["team-a", "team-b"], IN);
    check("adds teams", r.added.length === 2 && r.application.tracks.length === 2);
    const again = await setSelectedTracks(u1.id, ["team-a", "team-b"], IN);
    check("same selection is a no-op", again.added.length === 0 && again.removed.length === 0);
  }
  await saveDraft(u1.id, { trackAnswers: { "team-a": { a_experience: "Built a rig" }, "team-b": { b_tools: ["Tool 1"] } } }, IN);
  {
    const r = await setSelectedTracks(u1.id, ["team-a"], IN);
    check("dropping a team removes its row and answers", r.removed.join() === "team-b" && r.application.tracks.length === 1);
    check("the kept team's answers survive", JSON.stringify(r.application.tracks[0].answers).includes("Built a rig"));
  }
  await setSelectedTracks(u1.id, ["team-a", "team-b"], IN);

  console.log("--- submitting ---");
  await expectError("incomplete application can't be submitted", () => submitApplication(u1.id, IN), "INCOMPLETE", (e) => !!e.report && !e.report.complete && e.report.sections.some((s) => !s.complete));
  check("it is still a draft", (await getMyApplication(u1.id))?.state === "DRAFT");
  await saveDraft(u1.id, { genericAnswers: GENERIC, resumeUrl: RESUME, trackAnswers: { "team-a": { a_experience: "Built a rig" } } }, IN);
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
  await expectError("changing teams after submit is rejected", () => setSelectedTracks(u1.id, ["team-a"], IN), "ALREADY_SUBMITTED");
  await expectError("submitting twice is rejected", () => submitApplication(u1.id, IN), "ALREADY_SUBMITTED");

  console.log("--- isolation between applicants ---");
  {
    const a2 = await getMyApplication(u2.id);
    check("u2 sees their own empty draft, not u1's", a2 !== null && a2.id !== d1.id && a2.state === "DRAFT" && a2.tracks.length === 0);
    const view2 = await getApplicantStatus(u2.id, IN);
    check("u2's status view contains none of u1's data", !JSON.stringify(view2).includes("Built a rig") && !JSON.stringify(view2).includes(u1.email));
    check("a user with no application gets null", (await getApplicantStatus(officer.id, IN)).application === null);
  }

  console.log("--- a second applicant: draft stays invisible to officers ---");
  await setSelectedTracks(u3.id, ["team-b", "team-c"], IN);
  await saveDraft(u3.id, { genericAnswers: GENERIC, resumeUrl: RESUME, trackAnswers: { "team-c": { c_motivation: "x", c_hours: "4 to 6", c_link: "https://example.com/w" } } }, IN);
  const d3 = await getMyApplication(u3.id);
  {
    const list = await listTrackApplications({ cycleId: cycle.id, q: run });
    check("the draft's teams are not in the officer list", !list.rows.some((r) => r.application.userId === u3.id));
    check("the submitted application's two teams are", list.rows.filter((r) => r.application.userId === u1.id).length === 2, `rows=${list.rows.length}`);
    check("opening a draft by id returns null", (await getApplicationDetail(d3!.id)) === null);
    const v3 = await getApplicantStatus(u3.id, IN);
    check("draft statuses are hidden from the applicant too", v3.application?.tracks.every((t) => t.status === null) === true);
  }
  await submitApplication(u3.id, IN);

  console.log("--- officer list and filters ---");
  {
    const all = await listTrackApplications({ cycleId: cycle.id, q: run });
    check("both applicants appear (4 team rows)", all.total === 4 && all.rows.length === 4, `total=${all.total}`);
    check("filter by team", (await listTrackApplications({ cycleId: cycle.id, q: run, track: "team-c" })).rows.every((r) => r.track === "team-c"));
    check("filter by status", (await listTrackApplications({ cycleId: cycle.id, q: run, status: "ACCEPTED" })).total === 0);
    check("search matches name or email", (await listTrackApplications({ cycleId: cycle.id, q: "TEST U3" })).rows.some((r) => r.application.userId === u3.id));
    check("autoSubmitted filter", (await listTrackApplications({ cycleId: cycle.id, q: run, autoSubmitted: true })).total === 0);
    const detail = await getApplicationDetail(d1.id);
    check("detail returns the applicant narrowly (no email field on user)", detail !== null && !("email" in detail.user) && detail.tracks.length === 2);
  }

  console.log("--- decisions ---");
  const trackA = (await prisma.applicationTrack.findFirstOrThrow({ where: { applicationId: d1.id, track: "team-a" } })).id;
  const trackB = (await prisma.applicationTrack.findFirstOrThrow({ where: { applicationId: d1.id, track: "team-b" } })).id;
  await expectError("an officer can't decide their own application", () => setTrackStatus(u1.id, trackA, "ACCEPTED"), "SELF_REVIEW");
  await expectError("Interview is refused for a team without interviews", () => setTrackStatus(officer.id, trackB, "INTERVIEW"), "INTERVIEW_NOT_OFFERED");
  await expectError("an officer can't set SUBMITTED", () => setTrackStatus(officer.id, trackA, "SUBMITTED"), "BAD_STATUS");
  await expectError("unknown id", () => setTrackStatus(officer.id, "does-not-exist", "ACCEPTED"), "NOT_FOUND");
  {
    const r = await setTrackStatus(officer.id, trackA, "INTERVIEW");
    check("Interview works for a team that interviews", r.status === "INTERVIEW" && r.previousStatus === "SUBMITTED" && r.applicantUserId === u1.id);
    const row = await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackA } });
    check("decision time and officer are recorded", !!row.decidedAt && row.decidedById === officer.id);
    await expectError("same status twice is rejected", () => setTrackStatus(officer.id, trackA, "INTERVIEW"), "BAD_STATUS");
    await setTrackStatus(officer.id, trackB, "REJECTED");
    check("the two teams are decided independently", (await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackB } })).status === "REJECTED" && (await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackA } })).status === "INTERVIEW");
    const audits = await prisma.auditLog.count({ where: { entityType: "APPLICATION_TRACK", entityId: { in: [trackA, trackB] }, actionType: "APPLICATION_TRACK_STATUS_CHANGED" } });
    check("each change wrote an audit entry", audits === 2, `audits=${audits}`);
    await setTrackStatus(officer.id, trackA, "IN_REVIEW");
    const back = await prisma.applicationTrack.findUniqueOrThrow({ where: { id: trackA } });
    check("moving back to In review clears the decision", back.status === "IN_REVIEW" && back.decidedAt === null && back.decidedById === null);
  }

  console.log("--- booking link visibility ---");
  {
    await prisma.recruitingTrackConfig.upsert({
      where: { cycleId_track: { cycleId: cycle.id, track: "team-a" } },
      create: { cycleId: cycle.id, track: "team-a", schedulingUrl: "https://calendar.app.google/example" },
      update: { schedulingUrl: "https://calendar.app.google/example" },
    });
    const ta = (await getApplicantStatus(u1.id, IN)).application!.tracks.find((t) => t.track === "team-a")!;
    check("no booking link unless the team has invited them", ta.bookingUrl === null);
    await setTrackStatus(officer.id, trackA, "INTERVIEW");
    const ta2 = (await getApplicantStatus(u1.id, IN)).application!.tracks.find((t) => t.track === "team-a")!;
    check("booking link appears once invited to interview", ta2.bookingUrl === "https://calendar.app.google/example");
    await setTrackStatus(officer.id, trackA, "ACCEPTED");
    const ta3 = (await getApplicantStatus(u1.id, IN)).application!.tracks.find((t) => t.track === "team-a")!;
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
    const list = await listTrackApplications({ cycleId: cycle.id, q: run, track: "team-a" });
    const row = list.rows.find((x) => x.application.userId === u1.id)!;
    check("list shows review count and average score", row.reviewCount === 2 && row.averageScore === 4, `${row.reviewCount} / ${row.averageScore}`);
  }
  {
    const draftTrack = await prisma.applicationTrack.create({ data: { applicationId: (await getOrCreateDraft(u2.id, IN)).id, track: "team-b" } });
    await expectError("can't review a draft's team", () => addReview(officer.id, draftTrack.id, { score: 3 }), "NOT_FOUND");
    await expectError("can't decide a draft's team", () => setTrackStatus(officer.id, draftTrack.id, "IN_REVIEW"), "NOT_FOUND");
  }

  console.log("--- a draft left unsubmitted after the deadline ---");
  {
    const v = await getApplicantStatus(u2.id, AFTER);
    check("it is shown as expired, not submitted", v.application?.expiredUnsubmitted === true && v.application.state === "DRAFT" && v.round?.window === "closed");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
}

async function cleanup() {
  const apps = await prisma.application.findMany({ where: { userId: { in: userIds } }, select: { id: true, tracks: { select: { id: true } } } });
  const entityIds = apps.flatMap((a) => [a.id, ...a.tracks.map((t) => t.id)]);
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: entityIds } }, { actorUserId: { in: userIds } }, { targetUserId: { in: userIds } }] } });
  await prisma.recruitingTrackConfig.deleteMany({ where: { schedulingUrl: "https://calendar.app.google/example" } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // cascades applications, teams, reviews, emails
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
