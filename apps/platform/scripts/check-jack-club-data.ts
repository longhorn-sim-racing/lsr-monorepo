/**
 * Checks the club-data track (#188) against the LOCAL database: what unit tests can't, because it
 * lives in Postgres.
 *
 *   - every search source's SQL: the JackSearchDoc triggers, websearch_to_tsquery, ranks and
 *     ts_headline snippets; archived knowledge, deleted documents, drafts, hidden posts and Jack's
 *     own answers stay out unless they should be in
 *   - the readers, including a room message with the messages around it
 *   - the recruiting pipeline: drafts never load, an officer's application loses its team, status
 *     and reviews under Jack's rule, and only the viewer's reviews go under the page's rule
 *   - race data: public-only loads leave out a draft event's sessions, and the numbers add up
 *   - a room snapshot opened at an old message (?m=) holds it and what's around it, and the gap
 *     before the newest
 *
 *   cd apps/platform
 *   NODE_ENV=production pnpm exec tsx scripts/check-jack-club-data.ts
 *
 * Refuses to run unless DATABASE_URL points at 127.0.0.1 or localhost. It writes only rows it
 * creates (all tagged with one random word) and deletes them at the end, pass or fail. It never
 * touches ConnectorState: with Teams switched off (as it ships) it runs the Teams source's SQL
 * directly and checks the switch keeps it out of search.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localDatabaseProblem } from "../src/server/jack/eval-support";

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const databaseProblem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
if (databaseProblem) {
  console.error(`Refusing to run: ${databaseProblem}`);
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

let failed = false;
function check(step: string, ok: boolean, note?: string) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${note ? `  (${note})` : ""}`);
}

async function main() {
  const { prisma } = await import("../src/server/db");
  const { search } = await import("../src/server/jack/search/search");
  const { SEARCH_SOURCES, findReader } = await import("../src/server/jack/search/registry");
  const { teamsSource, TEAMS_OFF, teamsEnabled } = await import("../src/server/jack/search/sources/teams");
  const { JACK_ANSWER_LABEL } = await import("../src/server/jack/search/sources/rooms");
  const { searchRooms } = await import("../src/server/jack/room-search");
  const { getRoomSnapshot } = await import("../src/server/jack/rooms");
  const { applyPipelineRules, loadPipelineRows, summarizePipeline } = await import("../src/server/queries/recruiting-pipeline");
  const { loadRaceData } = await import("../src/server/queries/race-performance");
  const { driverTrend, positionsGained, summarizeDrivers } = await import("../src/lib/race-performance");

  // One made-up word every row carries, so searches find only this run's rows
  const tag = `zq${randomBytes(5).toString("hex")}`;
  const ids: Record<string, string[]> = {};
  const remember = (table: string, id: string) => {
    (ids[table] ??= []).push(id);
    return id;
  };
  console.log(`Tag: ${tag}`);

  try {
    // People: an applicant, an officer who applied, a reviewer, and someone with only a draft
    const person = async (key: string) =>
      remember("user", (await prisma.user.create({ data: { email: `${tag}-${key}@example.test`, handle: `${tag}-${key}`, displayName: `Check ${key} ${tag}` } })).id);
    const applicant = await person("applicant");
    const officer = await person("officer");
    const reviewer = await person("reviewer");
    const drafter = await person("drafter");
    const officerRole = await prisma.role.findUnique({ where: { key: "officer" } });
    if (officerRole) await prisma.userRole.create({ data: { userId: officer, roleId: officerRole.id } });

    // ----- search sources -----
    const room = remember("room", (await prisma.jackRoom.create({ data: { title: `Check room ${tag}`, createdById: applicant } })).id);
    const base = Date.now() - 600 * 60_000;
    const minute = (n: number) => new Date(base + n * 60_000);
    await prisma.jackMessage.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({ roomId: room, kind: "user" as const, authorUserId: applicant, content: `Filler message ${i}`, createdAt: minute(i) })),
    });
    const officerMessage = await prisma.jackMessage.create({ data: { roomId: room, kind: "user", authorUserId: applicant, content: `We decided the sponsorship budget is $500 ${tag}.`, createdAt: minute(530) } });
    await prisma.jackMessage.create({ data: { roomId: room, kind: "system", authorUserId: applicant, content: `Applicant renamed this room ${tag}`, createdAt: minute(531) } });
    const jackReply = await prisma.jackMessage.create({ data: { roomId: room, kind: "assistant", persona: "jack", content: `I think the budget is $900 ${tag}.`, createdAt: minute(532) } });
    await prisma.jackMessage.create({ data: { roomId: room, kind: "assistant", persona: "jack", status: "streaming", content: `Still streaming ${tag}`, createdAt: minute(533) } });

    remember("knowledge", (await prisma.knowledgeEntry.create({ data: { title: `Sponsor tiers ${tag}`, body: `# Tiers\n\nGold sponsors get a logo on the car. ${tag}`, tags: ["sponsors"], sourceType: "JACK", createdById: reviewer } })).id);
    remember("knowledge", (await prisma.knowledgeEntry.create({ data: { title: `Old tiers ${tag}`, body: `Archived ${tag}`, archivedAt: new Date() } })).id);

    const now = new Date();
    remember("document", (await prisma.externalDocument.create({ data: { source: "drive", externalId: `${tag}-1`, name: `Budget ${tag}.docx`, path: "/Finance", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", webUrl: "https://docs.google.com/document/d/x", modifiedAt: now, text: `The ${tag} budget for tires.`, textStatus: "ok", syncedAt: now } })).id);
    remember("document", (await prisma.externalDocument.create({ data: { source: "drive", externalId: `${tag}-2`, name: `Deleted ${tag}.docx`, path: "/", mimeType: "text/plain", webUrl: "https://docs.google.com/document/d/y", modifiedAt: now, text: null, textStatus: "ok", syncedAt: now, deletedAt: now } })).id);

    const channelId = `19:${tag}@thread.tacv2`;
    await prisma.teamsChannel.create({ data: { id: channelId, teamId: `team-${tag}`, name: "general" } });
    remember("teamsChannel", channelId);
    await prisma.teamsMessage.create({ data: { id: `${tag}-root`, channelId, authorName: "Dylan", content: `Is the ${tag} budget approved?`, createdAt: minute(10) } });
    await prisma.teamsMessage.create({ data: { id: `${tag}-reply`, channelId, replyToId: `${tag}-root`, authorName: "Gray", content: "Yes.", createdAt: minute(11) } });

    remember("post", (await prisma.post.create({ data: { title: `Season news ${tag}`, slug: `${tag}-news`, bodyMd: `The ${tag} season starts soon.`, publishedAt: new Date(Date.now() - 86_400_000), visibility: "public" } })).id);
    remember("post", (await prisma.post.create({ data: { title: `Draft news ${tag}`, slug: `${tag}-draft`, bodyMd: `Secret ${tag}`, publishedAt: null } })).id);
    const publicEvent = remember("event", (await prisma.event.create({ data: { slug: `${tag}-round`, title: `LSC Round 1 ${tag}`, description: `Race night ${tag}`, startsAtUtc: minute(100), endsAtUtc: minute(220), timezone: "America/Chicago", status: "PUBLISHED", meetingUrl: `https://meet.example/${tag}-private` } })).id);
    const draftEvent = remember("event", (await prisma.event.create({ data: { slug: `${tag}-draft-event`, title: `Draft event ${tag}`, startsAtUtc: minute(300), endsAtUtc: minute(400), timezone: "America/Chicago", status: "DRAFT" } })).id);
    const album = remember("album", (await prisma.galleryAlbum.create({ data: { slug: `${tag}-album`, title: `Fall social ${tag}` } })).id);
    remember("galleryImage", (await prisma.galleryImage.create({ data: { publicId: `${tag}-photo`, albumId: album } })).id);
    // An album with no photos yet: the gallery doesn't list it, so neither does search
    const emptyAlbum = remember("album", (await prisma.galleryAlbum.create({ data: { slug: `${tag}-empty`, title: `Empty album ${tag}` } })).id);
    remember("instagram", (await prisma.instagramPost.create({ data: { id: `${tag}-ig1`, permalink: "https://www.instagram.com/p/abc/", caption: `Race day ${tag}!`, mediaType: "IMAGE", postedAt: now } })).id);
    remember("instagram", (await prisma.instagramPost.create({ data: { id: `${tag}-ig2`, permalink: "https://www.instagram.com/p/def/", caption: `Hidden ${tag}`, mediaType: "IMAGE", postedAt: now, hidden: true } })).id);

    const byDefault = await search({ query: tag, limit: 25 });
    const titles = byDefault.hits.map((h) => `${h.type}:${h.title}`);
    check("search runs every default source's SQL", byDefault.outcomes.filter((o) => o.status !== "failed").length === SEARCH_SOURCES.length, JSON.stringify(byDefault.outcomes));
    check("knowledge: found, marked not reviewed; archived left out", titles.includes(`knowledge:Sponsor tiers ${tag}`) && !titles.some((t) => t.includes("Old tiers")) && byDefault.hits.find((h) => h.type === "knowledge")?.meta.notReviewed === true);
    check("documents: found; deleted left out", titles.includes(`document:Budget ${tag}.docx`) && !titles.some((t) => t.includes("Deleted")));
    check("rooms: the officer's message and the room note, not Jack's answers or a streaming reply", byDefault.hits.some((h) => h.id === officerMessage.id) && titles.some((t) => t.includes("Room note")) && !byDefault.hits.some((h) => h.title.includes(JACK_ANSWER_LABEL)) && !titles.some((t) => t.includes("Still streaming")));
    check("site: the published post, public event, album and visible Instagram post", ["post:Season news", "event:LSC Round 1", "album:Fall social", "instagram:Instagram: Race day"].every((prefix) => titles.some((t) => t.startsWith(prefix))));
    check("site: no draft post, draft event, hidden Instagram post or album without photos", !titles.some((t) => /Draft news|Draft event|Hidden|Empty album/.test(t)));
    check("snippets come from ts_headline", byDefault.hits.every((h) => h.snippet.length > 0) && byDefault.hits.find((h) => h.type === "document")!.snippet.includes("tires"), byDefault.hits.map((h) => h.snippet).join(" | "));
    check("ranks are in 0..1 and sorted", byDefault.hits.every((h, i, all) => h.rank >= 0 && h.rank <= 1 && (i === 0 || all[i - 1].rank >= h.rank)));

    const withJack = await search({ query: `budget ${tag}`, sources: ["rooms"], limit: 10, includeJackReplies: true });
    check("rooms: Jack's answers only when asked, labelled not a source", withJack.hits.some((h) => h.title.startsWith(JACK_ANSWER_LABEL)));
    await prisma.jackMessage.update({ where: { id: officerMessage.id }, data: { answeredById: jackReply.id } });
    const fromThatReply = await search({ query: tag, sources: ["rooms"], limit: 10, replyId: jackReply.id });
    check("rooms: a reply's own question isn't one of its results", fromThatReply.hits.length > 0 && !fromThatReply.hits.some((h) => h.id === officerMessage.id));

    const teamsOn = await teamsEnabled();
    if (!teamsOn) {
      check("Teams: switched off, so search skips it", byDefault.outcomes.some((o) => o.source === "teams" && o.status === "unavailable" && o.reason === TEAMS_OFF));
      check("Teams: switched off, so read refuses", (await findReader("teams")!.read(`${tag}-reply`, {})).ok === false);
    } else console.log("NOTE  Teams is switched on in this database; checking its search through the switch");
    const teamsHits = await teamsSource.search({ query: tag, limit: 5, includeJackReplies: false });
    check("Teams: its SQL finds the message, linking into Teams", teamsHits.length === 1 && teamsHits[0].url.startsWith("https://teams.microsoft.com/l/message/") && teamsHits[0].title === "Dylan in #general");

    // ----- readers -----
    const read = async (type: string, id: string) => findReader(type)!.read(id, {});
    const roomRead = await read("room_message", officerMessage.id);
    check("read room_message: the message with the ones around it", roomRead.ok && roomRead.doc.text.includes("→ (the message you opened)") && roomRead.doc.text.includes("Room note") && roomRead.doc.text.includes(JACK_ANSWER_LABEL));
    const eventRead = await read("event", publicEvent);
    check("read event: public details, never the meeting link", eventRead.ok && !eventRead.doc.text.includes("meet.example"));
    check("read event: a draft event isn't readable", !(await read("event", draftEvent)).ok);
    check("read album: one with photos, not one without", (await read("album", album)).ok && !(await read("album", emptyAlbum)).ok);
    const docRead = await read("document", ids.document[0]);
    check("read document: its text", docRead.ok && docRead.doc.text.includes("tires"));
    check("read document: a deleted one says its text is gone", !(await read("document", ids.document[1])).ok);

    // ----- the rooms list search and a snapshot at an old message -----
    const listSearch = await searchRooms(tag);
    check("rooms list search: the room by name and messages of every kind, linked in place", listSearch.rooms.some((r) => r.id === room) && listSearch.messages.some((m) => m.kind === "assistant") && listSearch.messages.every((m) => m.href.startsWith(`/admin/jack/${room}?m=`)));
    const early = await prisma.jackMessage.findFirst({ where: { roomId: room, content: "Filler message 10" }, select: { id: true } });
    const latest = await getRoomSnapshot(room);
    const anchored = await getRoomSnapshot(room, { around: early!.id });
    check("snapshot: without an anchor, the latest 500 (the old message isn't there)", latest!.messages.length === 500 && !latest!.messages.some((m) => m.id === early!.id));
    // 524 messages: the window is the 10 before filler 10, it and the 459 after it (to filler 469); the other 54 are the gap
    check(
      "snapshot at an old message: it, the 10 before it and 459 after, in order, no bigger than a normal snapshot",
      anchored!.messages.some((m) => m.id === early!.id) && anchored!.messages[0].content === "Filler message 0" && anchored!.messages.at(-1)!.content === "Filler message 469" && anchored!.messages.length === 470,
      `${anchored!.messages.length} messages`,
    );
    check(
      "snapshot at an old message: the gap after it runs to the newest",
      anchored!.gap?.count === 54 && anchored!.gap.after.id === anchored!.messages.at(-1)!.id && anchored!.gap.through.id === latest!.messages.at(-1)!.id,
      JSON.stringify(anchored!.gap),
    );

    // ----- recruiting -----
    const cycle = remember("cycle", (await prisma.recruitingCycle.create({ data: { slug: `check-${tag}`, name: `Check ${tag}`, opensAt: minute(0), closesAt: new Date(Date.now() + 86_400_000) } })).id);
    const apply = async (userId: string, state: "DRAFT" | "SUBMITTED", tracks: { track: string; status: "SUBMITTED" | "IN_REVIEW" | "REJECTED"; scores: number[] }[]) => {
      const application = await prisma.application.create({ data: { cycleId: cycle, userId, state, formVersion: 1, fullName: `Applicant ${tag}`, email: `${tag}@example.test`, eid: `zz${tag.slice(2, 7)}`, submittedAt: state === "SUBMITTED" ? minute(5) : null } });
      remember("application", application.id);
      for (const t of tracks) {
        const track = await prisma.applicationTrack.create({ data: { applicationId: application.id, track: t.track, status: t.status } });
        for (const score of t.scores) await prisma.applicationReview.create({ data: { applicationTrackId: track.id, reviewerId: reviewer, score } });
      }
    };
    await apply(applicant, "SUBMITTED", [
      { track: "media", status: "SUBMITTED", scores: [] },
      { track: "technology", status: "IN_REVIEW", scores: [4] },
    ]);
    await apply(officer, "SUBMITTED", [{ track: "media", status: "REJECTED", scores: [1] }]);
    await apply(drafter, "DRAFT", [{ track: "media", status: "SUBMITTED", scores: [] }]);

    const loaded = await loadPipelineRows(cycle);
    check("pipeline: drafts never load", loaded.length === 3 && !loaded.some((r) => r.application.userId === drafter));
    check("pipeline: no email or EID unless asked", loaded.every((r) => !("email" in r.application) && !("eid" in r.application)));
    const forJack = applyPipelineRules(loaded, { hideOfficerApplicants: true, viewerId: null });
    const jackSummary = summarizePipeline(forJack.rows);
    if (officerRole) {
      check("pipeline (Jack): the officer's application only shows that they applied", forJack.hidden.length === 1 && jackSummary.teamApplications === 2 && jackSummary.teams.find((t) => t.team === "media")!.byStatus.REJECTED === 0);
      check("pipeline (Jack): their review isn't in any score", jackSummary.averageScore === 4 && jackSummary.reviewers[0].reviews === 1);
    } else console.log("SKIP  no officer role in this database, so the officer-applicant rule wasn't checked");
    const forPage = summarizePipeline(applyPipelineRules(loaded, { hideOfficerApplicants: false, viewerId: officer }).rows);
    check("pipeline (page): everyone counted, the viewer's own reviews left out", forPage.teamApplications === 3 && forPage.reviewers[0].reviews === 1 && forPage.teams.find((t) => t.team === "media")!.byStatus.REJECTED === 1);
    check("pipeline: unreviewed = no reviews and no decision", jackSummary.unreviewed === 1);

    // ----- race data -----
    const upload = remember("upload", (await prisma.rawResultUpload.create({ data: { filename: `${tag}.json`, filesize: 2, sha256: tag, rawJson: {}, uploadedByUserId: reviewer, status: "INGESTED", eventId: publicEvent } })).id);
    const session = async (eventId: string, sessionType: string, at: number) =>
      (await prisma.raceSession.create({ data: { uploadId: upload, eventId, sessionType, trackName: `${tag}_monza`, startedAt: minute(at) } })).id;
    const quali = await session(publicEvent, "QUALIFYING", 100);
    const race = await session(publicEvent, "RACE", 130);
    const hiddenRace = await session(draftEvent, "RACE", 300);
    const drive = async (sessionId: string, guid: string, userId: string | null, position: number, laps: number[], cuts = 0) => {
      const participant = await prisma.raceParticipant.create({ data: { sessionId, driverGuid: guid, displayName: `Sim ${guid}`, carName: "ks_car", carClass: "GT3", userId } });
      await prisma.raceResult.create({ data: { sessionId, participantId: participant.id, position, classPosition: 0, bestLapTime: Math.min(...laps), lapsCompleted: laps.length, status: "FINISHED", totalCuts: cuts, collisionCount: 0, points: 26 - position } });
      await prisma.raceLap.createMany({ data: laps.map((lapTime, i) => ({ sessionId, participantId: participant.id, lapNumber: i + 1, lapTime, valid: true, cuts: 0 })) });
      return participant.id;
    };
    await drive(quali, `${tag}-a`, applicant, 2, [91_000]);
    await drive(quali, `${tag}-b`, null, 1, [90_500]);
    const applicantRace = await drive(race, `${tag}-a`, applicant, 1, [99_000, 92_000, 92_400, 92_200, 92_600, 92_100]);
    await drive(race, `${tag}-b`, null, 2, [99_500, 93_000, 93_100], 2);
    await drive(hiddenRace, `${tag}-a`, applicant, 3, [95_000]);
    await prisma.raceEvent.create({ data: { sessionId: race, type: "COLLISION_WITH_ENV", participantId: applicantRace, impactSpeed: 40 } });

    const all = await loadRaceData({ eventIds: [publicEvent, draftEvent], withLaps: true, withIncidents: true });
    const publicOnly = await loadRaceData({ userId: applicant, publicOnly: true });
    check("race data: every session of the two events", all.sessions.length === 3);
    check("race data (public): the draft event's race is left out", publicOnly.sessions.length === 2 && !publicOnly.sessions.some((s) => s.id === hiddenRace));
    check("race data: a member by their profile, a guest by the file's name", all.results.some((r) => r.driver.key === applicant) && all.results.some((r) => r.driver.key === `guid:${tag}-b` && r.driver.name === `Sim ${tag}-b`));
    check("race data: positions gained from qualifying", positionsGained(all).get(`${race}:${applicantRace}`)?.gained === 1);
    const drivers = summarizeDrivers(filterTo(all, [quali, race]));
    const me = drivers.find((d) => d.driver.key === applicant)!;
    check("race data: clean laps, collisions split by type", me.cleanLaps === 5 && me.collisionsWithEnv === 1 && me.consistencyPct !== null, JSON.stringify(me));
    check("race data: a driver's trend", driverTrend(publicOnly, applicant).map((r) => r.position).join(",") === "1");
  } finally {
    await cleanup(prisma, ids, tag);
  }

  function filterTo(data: Awaited<ReturnType<typeof loadRaceData>>, sessionIds: string[]) {
    const keep = new Set(sessionIds);
    return { sessions: data.sessions.filter((s) => keep.has(s.id)), results: data.results.filter((r) => keep.has(r.sessionId)), laps: data.laps.filter((l) => keep.has(l.sessionId)), incidents: data.incidents.filter((i) => keep.has(i.sessionId)) };
  }
}

/** Deletes everything the run made, children first; then checks the search index forgot it */
async function cleanup(prisma: (typeof import("../src/server/db"))["prisma"], ids: Record<string, string[]>, tag: string) {
  const messageIds = (await prisma.jackMessage.findMany({ where: { roomId: { in: ids.room ?? [] } }, select: { id: true } })).map((m) => m.id);
  const steps: [string, () => Promise<unknown>][] = [
    ["uploads", () => prisma.rawResultUpload.deleteMany({ where: { id: { in: ids.upload ?? [] } } })],
    ["applications", () => prisma.application.deleteMany({ where: { id: { in: ids.application ?? [] } } })],
    ["round", () => prisma.recruitingCycle.deleteMany({ where: { id: { in: ids.cycle ?? [] } } })],
    ["Instagram posts", () => prisma.instagramPost.deleteMany({ where: { id: { in: ids.instagram ?? [] } } })],
    ["photos", () => prisma.galleryImage.deleteMany({ where: { id: { in: ids.galleryImage ?? [] } } })],
    ["albums", () => prisma.galleryAlbum.deleteMany({ where: { id: { in: ids.album ?? [] } } })],
    ["events", () => prisma.event.deleteMany({ where: { id: { in: ids.event ?? [] } } })],
    ["posts", () => prisma.post.deleteMany({ where: { id: { in: ids.post ?? [] } } })],
    ["Teams messages", () => prisma.teamsMessage.deleteMany({ where: { channelId: { in: ids.teamsChannel ?? [] } } })],
    ["Teams channel", () => prisma.teamsChannel.deleteMany({ where: { id: { in: ids.teamsChannel ?? [] } } })],
    ["documents", () => prisma.externalDocument.deleteMany({ where: { id: { in: ids.document ?? [] } } })],
    ["knowledge", () => prisma.knowledgeEntry.deleteMany({ where: { id: { in: ids.knowledge ?? [] } } })],
    ["room", () => prisma.jackRoom.deleteMany({ where: { id: { in: ids.room ?? [] } } })],
    ["people", () => prisma.user.deleteMany({ where: { id: { in: ids.user ?? [] } } })],
  ];
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      failed = true;
      console.error(`FAIL  cleanup: couldn't delete the ${what} (tag ${tag}):`, error instanceof Error ? error.message : error);
    }
  }
  const indexed = [...(ids.knowledge ?? []), ...(ids.document ?? []), ...messageIds];
  const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "JackSearchDoc" WHERE "sourceId" = ANY(${indexed}) OR "sourceId" LIKE ${`${tag}%`}`;
  check("cleanup: the search index forgot every row", Number(left[0].n) === 0);
  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed = true;
    console.error(error);
  })
  .finally(() => {
    console.log(failed ? "\nSome checks FAILED." : "\nAll checks passed.");
    process.exit(failed ? 1 : 0);
  });
