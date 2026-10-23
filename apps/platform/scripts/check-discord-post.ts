/**
 * LOCAL ONLY: checks Discord posting (Jack 2.0 discord-post track) against the local database, where the
 * unit tests only see an in-memory table: the SENDING claim under real concurrency (several claims at
 * once, exactly one wins), the dedupe key's uniqueness and how cancelling frees it, a reminder rule over a
 * real event (queued, moved, cancelled), and sending through the outbox to the Discord HTTP fake (answered
 * in this process, no server needed), with a dropped connection retried on the same nonce.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-discord-post.ts
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. It writes only its own rows (a temporary
 * event, rule and posts named after this run) and deletes them again, pass or fail, and puts the posting
 * channels setting back as it was. The rule part is skipped when another standing rule is switched on
 * (the run would act on it too).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

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

// Quiet Prisma (it logs every query outside production)
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const FAKES_ORIGIN = "http://127.0.0.1:3999";
process.env.JACK_FAKES = "discord";
process.env.JACK_FAKES_URL = FAKES_ORIGIN;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
}

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }

  const { prisma } = await import("../src/server/db");
  const { createFakeRouter } = await import("../src/server/connectors/fakes/router");
  const { discordFake } = await import("../src/server/connectors/discord/fake/handlers");
  const { FAKE_CHANNELS, FAKE_DISCORD } = await import("../src/server/connectors/discord/fake/data");
  const { discordClient } = await import("../src/server/connectors/discord/client");
  const { discordWriter } = await import("../src/server/connectors/discord/write");
  const outbox = await import("../src/server/discord-post/outbox");
  const { POSTING_SETTING } = await import("../src/server/discord-post/channels");
  const { runDiscordRules, rulePostProblem, ruleKey } = await import("../src/server/discord-post/rule-runner");

  const router = createFakeRouter([discordFake]);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== FAKES_ORIGIN) throw new Error(`check-discord-post only talks to the fake, not ${new URL(request.url).origin}`);
    return router(request);
  };
  const hook = (path: string, body: unknown) => fetch(`${FAKES_ORIGIN}/discord/_fake/${path}`, { method: "POST", body: JSON.stringify(body) });
  const writer = discordWriter(discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId }).rest, FAKE_DISCORD.guildId);

  const run = randomUUID().slice(0, 8);
  const prefix = `check-discord-post:${run}`;
  const ruleId = randomUUID();
  const eventId = randomUUID();
  const channelId = FAKE_CHANNELS.announcements;
  const body = (content: string) => ({ content, allowed_mentions: { parse: [] as [] } });
  const savedSetting = await prisma.systemSetting.findUnique({ where: { key: POSTING_SETTING } });

  try {
    // The claim, under real concurrency
    const { post } = await outbox.queueDiscordPost({ source: "admin", channelId, body: body(`${prefix} claim`), dedupeKey: `${prefix}:claim`, scheduledFor: new Date(Date.now() - 1000) });
    const claims = await Promise.all(Array.from({ length: 8 }, () => outbox.claimPost(post.id, new Date())));
    check("of 8 claims at once, exactly one wins", claims.filter(Boolean).length === 1, JSON.stringify(claims));

    // The dedupe key
    const again = await outbox.queueDiscordPost({ source: "admin", channelId, body: body("other"), dedupeKey: `${prefix}:claim` });
    check("a second post with the same key returns the first", !again.created && again.post.id === post.id);
    const released = await outbox.queueDiscordPost({ source: "rule", channelId, body: body(`${prefix} r`), dedupeKey: `${prefix}:release`, scheduledFor: new Date(Date.now() + 3_600_000) });
    await outbox.cancelPosts({ id: released.post.id }, "moved", { release: true });
    const revived = await outbox.queueDiscordPost({ source: "rule", channelId, body: body(`${prefix} r2`), dedupeKey: `${prefix}:release`, scheduledFor: new Date(Date.now() + 3_600_000) });
    check("cancelling with release frees the key for a new post", revived.created && revived.post.id !== released.post.id);
    const kept = await outbox.queueDiscordPost({ source: "rule", channelId, body: body(`${prefix} k`), dedupeKey: `${prefix}:keep`, scheduledFor: new Date(Date.now() + 3_600_000) });
    await outbox.cancelPosts({ id: kept.post.id }, "Cancelled by a check", { release: false });
    check("an officer's cancel keeps the key", !(await outbox.queueDiscordPost({ source: "rule", channelId, body: body("x"), dedupeKey: `${prefix}:keep` })).created);

    // Sending through the fake: a dropped connection retried on the same nonce posts once
    await hook("drop", { path: "/messages", when: "after", times: 1 });
    const due = await outbox.queueDiscordPost({ source: "admin", channelId, body: body(`${prefix} send`), dedupeKey: `${prefix}:send` });
    const outcome = await outbox.sendPostNow(due.post.id, writer, { pause: async () => {} });
    const row = await prisma.discordPost.findUnique({ where: { id: due.post.id } });
    const inChannel = (await writer.messagesAfter(channelId, "0")).filter((m) => m.content === `${prefix} send`);
    check("a send whose answer was lost is retried with its nonce and posts once", outcome.status === "SENT" && row?.status === "SENT" && inChannel.length === 1, JSON.stringify({ outcome, status: row?.status, count: inChannel.length }));

    // A reminder rule over a real event
    const others = await prisma.discordRule.count({ where: { enabled: true, kind: { not: "event_mirror" } } });
    if (others) {
      console.log(`SKIP  the rule checks: ${others} other standing rule(s) are switched on in this database`);
    } else {
      await prisma.systemSetting.upsert({ where: { key: POSTING_SETTING }, update: { value: JSON.stringify({ channels: [channelId] }) }, create: { key: POSTING_SETTING, value: JSON.stringify({ channels: [channelId] }) } });
      const start = new Date(Date.now() + 2 * 86_400_000);
      start.setUTCSeconds(0, 0);
      await prisma.event.create({ data: { id: eventId, slug: `${prefix.replace(/:/g, "-")}`, title: `Check event ${run}`, startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 7_200_000), timezone: "America/Chicago", status: "PUBLISHED", visibility: "public", publishedAt: new Date(), meetingUrl: "https://meet.example/secret" } });
      await prisma.discordRule.create({ data: { id: ruleId, kind: "event_reminder", channelId, config: { offsets: [1440, 60] }, enabled: true, cutoffAt: new Date(Date.now() - 60_000) } });
      // The rule acts on every public event in the database; these checks look at this run's event
      const ours = { ruleId, dedupeKey: { startsWith: `event_reminder:${ruleId}:${eventId}:` } };
      const rulesRun = () => runDiscordRules({ now: new Date(), log: () => {}, siteUrl: "http://localhost:3000" });
      const first = await rulesRun();
      const reminders = await prisma.discordPost.findMany({ where: { ...ours, status: "SCHEDULED" } });
      check("the reminder rule schedules a post per offset for the public event", first.errors.length === 0 && reminders.length === 2, JSON.stringify(first));
      check("no reminder carries the event's meeting link", !JSON.stringify(reminders.map((r) => r.content)).includes("meet.example"));
      check("a scheduled reminder passes its last check", (await rulePostProblem(reminders[0], new Date())) === null);
      const second = await rulesRun();
      check("a second run adds nothing", second.queued === 0, JSON.stringify(second));

      const moved = new Date(start.getTime() + 86_400_000);
      await prisma.event.update({ where: { id: eventId }, data: { startsAtUtc: moved, endsAtUtc: new Date(moved.getTime() + 7_200_000) } });
      await rulesRun();
      const cancelled = await prisma.discordPost.findMany({ where: { id: { in: reminders.map((r) => r.id) } } });
      const live = await prisma.discordPost.findMany({ where: { ...ours, status: "SCHEDULED" } });
      check(
        "moving the event cancels its reminders (keys freed) and schedules new ones at the new time",
        cancelled.every((p) => p.status === "CANCELLED" && p.dedupeKey === null) && live.length === 2 && live.every((p) => p.dedupeKey?.startsWith(`event_reminder:${ruleId}:${eventId}:${moved.toISOString()}:`)),
        JSON.stringify({ cancelled: cancelled.map((p) => p.status), live: live.map((p) => p.dedupeKey) }),
      );
      check("the new keys are the rule's own", live.every((p) => [1440, 60].some((offset) => p.dedupeKey === ruleKey.reminder(ruleId, eventId, moved, offset))));

      await prisma.event.update({ where: { id: eventId }, data: { status: "CANCELLED" } });
      await rulesRun();
      check("cancelling the event cancels its pending reminders", (await prisma.discordPost.count({ where: { ruleId, id: { in: live.map((p) => p.id) }, status: "SCHEDULED" } })) === 0);
    }
  } finally {
    await prisma.discordPost.deleteMany({ where: { OR: [{ ruleId }, { dedupeKey: { startsWith: prefix } }, { content: { path: ["content"], string_starts_with: prefix } }] } });
    await prisma.discordRule.deleteMany({ where: { id: ruleId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
    if (savedSetting) await prisma.systemSetting.update({ where: { key: POSTING_SETTING }, data: { value: savedSetting.value } });
    else await prisma.systemSetting.deleteMany({ where: { key: POSTING_SETTING } });
    const left = await prisma.discordPost.count({ where: { OR: [{ ruleId }, { dedupeKey: { startsWith: prefix } }] } });
    check("cleaned up its rows", left === 0 && !(await prisma.event.findUnique({ where: { id: eventId } })));
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
