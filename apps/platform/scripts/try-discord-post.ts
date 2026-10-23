/**
 * LOCAL ONLY: fills the local database with Discord posting data, to look at Community → Announcements and
 * the Discord page's role sync and events sections in the browser without a real bot (Jack 2.0
 * discord-post track). Run scripts/try-discord.ts first (it syncs the fake server's channels). The real
 * rule runner and event mirror run, against the Discord HTTP fake answered in this process.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord.ts
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord-post.ts            # rules, posts, mirrored events, a role rule
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord-post.ts --clean    # remove them again
 *
 * It writes: the posting channels setting (#announcements and #general), four standing rules and a role
 * sync rule (fixed ids), a sample public event ("Try: GM 2", slug try-discord-post-gm-2), the posts the
 * rules queue plus a few in every state, and DiscordEventMirror rows for the upcoming public events.
 * The database is shared, so it touches only what it writes: it saves the posting setting it replaces
 * (SystemSetting `try-discord-post:saved`, with the mirror rows it made) and --clean puts it back, and it
 * refuses to run while other standing rules are switched on or other mirrored events exist (the rule
 * runner and the event mirror would act on those too). --clean removes the rest of what it made. It
 * leaves the `discord` connector as it is. Refuses unless DATABASE_URL points at 127.0.0.1 or localhost.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Prisma } from "@prisma/client";

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
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const FAKES_ORIGIN = "http://127.0.0.1:3999";
process.env.JACK_FAKES = "discord";
process.env.JACK_FAKES_URL = FAKES_ORIGIN;
const CLEAN = process.argv.includes("--clean");

const RULES = {
  reminders: "7a7d1500-0000-4000-8000-00000000d801",
  newEvents: "7a7d1500-0000-4000-8000-00000000d802",
  twitch: "7a7d1500-0000-4000-8000-00000000d803",
  mirror: "7a7d1500-0000-4000-8000-00000000d804",
};
const ROLE_RULE = "7a7d1500-0000-4000-8000-00000000d805";
const EVENT_SLUG = "try-discord-post-gm-2";
const KEY = "try-discord-post:";
/** What this script replaced or made in shared rows: the posting setting from before it ran (null: there was none) and the mirror rows' Discord event ids */
const SAVED = "try-discord-post:saved";
type Saved = { posting: string | null; mirrors: string[] };

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }
  const { prisma } = await import("../src/server/db");
  const { POSTING_SETTING } = await import("../src/server/discord-post/channels");

  const readSaved = async (): Promise<Saved | null> => {
    const row = await prisma.systemSetting.findUnique({ where: { key: SAVED } });
    if (!row) return null;
    const value = JSON.parse(row.value) as { posting?: unknown; mirrors?: unknown };
    return { posting: typeof value.posting === "string" ? value.posting : null, mirrors: Array.isArray(value.mirrors) ? value.mirrors.filter((id): id is string => typeof id === "string") : [] };
  };
  const writeSaved = async (saved: Saved) => {
    const value = JSON.stringify(saved);
    await prisma.systemSetting.upsert({ where: { key: SAVED }, update: { value }, create: { key: SAVED, value } });
  };

  /** Removes what this script made. `restore` also puts the posting setting back as it was before the first run */
  const clean = async ({ restore }: { restore: boolean }) => {
    const saved = await readSaved();
    const ruleIds = Object.values(RULES);
    const posts = await prisma.discordPost.deleteMany({ where: { OR: [{ ruleId: { in: ruleIds } }, { dedupeKey: { startsWith: KEY } }] } });
    await prisma.discordRule.deleteMany({ where: { id: { in: ruleIds } } });
    await prisma.discordRoleRule.deleteMany({ where: { id: ROLE_RULE } });
    const mirrors = saved?.mirrors.length ? await prisma.discordEventMirror.deleteMany({ where: { discordEventId: { in: saved.mirrors } } }) : { count: 0 };
    await prisma.event.deleteMany({ where: { slug: EVENT_SLUG } });
    if (!saved) {
      console.log(`Removed ${posts.count} posts, the rules and the sample event. No saved posting channels to put back.`);
      return;
    }
    if (!restore) return writeSaved({ ...saved, mirrors: [] });
    if (saved.posting === null) await prisma.systemSetting.deleteMany({ where: { key: POSTING_SETTING } });
    else await prisma.systemSetting.upsert({ where: { key: POSTING_SETTING }, update: { value: saved.posting }, create: { key: POSTING_SETTING, value: saved.posting } });
    await prisma.systemSetting.delete({ where: { key: SAVED } });
    console.log(`Removed ${posts.count} posts, the rules, ${mirrors.count} mirrored events and the sample event, and put the posting channels back as they were.`);
  };
  if (CLEAN) {
    await clean({ restore: true });
    await prisma.$disconnect();
    return;
  }

  const { createFakeRouter } = await import("../src/server/connectors/fakes/router");
  const { discordFake } = await import("../src/server/connectors/discord/fake/handlers");
  const { FAKE_CHANNELS, FAKE_DISCORD } = await import("../src/server/connectors/discord/fake/data");
  const { discordClient } = await import("../src/server/connectors/discord/client");
  const { discordWriter } = await import("../src/server/connectors/discord/write");
  const { runDiscordRules } = await import("../src/server/discord-post/rule-runner");
  const { runEventMirror } = await import("../src/server/discord-post/event-mirror");
  const { postBody } = await import("../src/server/discord-post/compose");
  const { postNonce } = await import("../src/server/discord-post/outbox");

  const router = createFakeRouter([discordFake]);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== FAKES_ORIGIN) throw new Error(`try-discord-post only talks to the fake, not ${new URL(request.url).origin}`);
    return router(request);
  };
  const writer = discordWriter(discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId }).rest, FAKE_DISCORD.guildId);

  const channels = await prisma.discordChannel.count({ where: { id: { in: [FAKE_CHANNELS.announcements, FAKE_CHANNELS.general] } } });
  if (channels < 2) {
    console.error("The fake server's channels aren't in the database. Run scripts/try-discord.ts first.");
    process.exit(1);
  }
  // The rule runner and the event mirror act on every rule that's on and every mirror row, so other people's would change too
  const known = (await readSaved())?.mirrors ?? [];
  const [otherRules, otherMirrors] = await Promise.all([
    prisma.discordRule.count({ where: { enabled: true, id: { notIn: Object.values(RULES) } } }),
    prisma.discordEventMirror.count({ where: { discordEventId: { notIn: known } } }),
  ]);
  if (otherRules || otherMirrors) {
    const others = [otherRules && `${otherRules} other standing ${otherRules === 1 ? "rule" : "rules"} switched on`, otherMirrors && `${otherMirrors} other mirrored ${otherMirrors === 1 ? "event" : "events"}`].filter(Boolean);
    console.error(`Refusing to run: this database has ${others.join(" and ")}, which this script's rule runner and event mirror would change. Switch those rules off on Announcements (or remove those mirror rows) first.`);
    process.exit(1);
  }

  // Save the posting setting this replaces, once: a second run keeps the first run's copy, unless someone picked other channels since
  const fakePosting = JSON.stringify({ channels: [FAKE_CHANNELS.announcements, FAKE_CHANNELS.general] });
  const current = (await prisma.systemSetting.findUnique({ where: { key: POSTING_SETTING } }))?.value ?? null;
  const saved = (await readSaved()) ?? { posting: current === fakePosting ? null : current, mirrors: [] };
  await writeSaved({ ...saved, posting: current !== null && current !== fakePosting ? current : saved.posting });
  await clean({ restore: false });
  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, select: { id: true } });
  const now = new Date();
  const HOUR = 3_600_000;

  await prisma.systemSetting.upsert({ where: { key: POSTING_SETTING }, update: { value: fakePosting }, create: { key: POSTING_SETTING, value: fakePosting } });
  const start = new Date(now.getTime() + 3 * 24 * HOUR);
  start.setUTCHours(23, 30, 0, 0);
  await prisma.event.create({
    data: { slug: EVENT_SLUG, title: "Try: GM 2", summary: "Meet the teams and the new sim rigs. Pizza after.", startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 2 * HOUR), timezone: "America/Chicago", status: "PUBLISHED", visibility: "public", publishedAt: new Date(now.getTime() - 60_000), registrationEnabled: true },
  });

  const cutoff = new Date(now.getTime() - 5 * 60_000);
  const lscPing = { type: "role", roleId: FAKE_DISCORD.roles.lscDriver, name: "LSC Driver" };
  await prisma.discordRule.createMany({
    data: [
      { id: RULES.reminders, kind: "event_reminder", channelId: FAKE_CHANNELS.announcements, config: { offsets: [1440, 60], series: null, ping: null }, enabled: true, cutoffAt: cutoff, createdById: officer?.id ?? null },
      { id: RULES.newEvents, kind: "new_event", channelId: FAKE_CHANNELS.announcements, config: { series: null, ping: lscPing }, enabled: true, cutoffAt: cutoff, createdById: officer?.id ?? null },
      { id: RULES.twitch, kind: "twitch_live", channelId: FAKE_CHANNELS.general, config: { ping: null }, enabled: false, cutoffAt: cutoff, createdById: officer?.id ?? null },
      { id: RULES.mirror, kind: "event_mirror", channelId: null, config: { series: null, location: "See the event page" }, enabled: true, cutoffAt: cutoff, createdById: officer?.id ?? null },
    ],
  });
  const rules = await runDiscordRules({ now, log: (line) => console.log(`  rules: ${line}`) });
  console.log(`Standing rules queued ${rules.queued} posts.`);

  type PostData = Omit<Prisma.DiscordPostUncheckedCreateInput, "id" | "nonce" | "source" | "channelId" | "content"> & { channelId?: string; content: object };
  const post = (n: number, data: PostData): Prisma.DiscordPostUncheckedCreateInput => ({
    source: "admin",
    channelId: FAKE_CHANNELS.announcements,
    dedupeKey: `${KEY}${n}`,
    createdById: officer?.id ?? null,
    approvedById: officer?.id ?? null,
    ...data,
    content: data.content as Prisma.InputJsonValue,
  });
  const rows = [
    post(1, { content: postBody({ text: "Sim lounge is open late this Friday. Bring your own wheel if you have one!" }), status: "SENT", scheduledFor: new Date(now.getTime() - 26 * HOUR), sentAt: new Date(now.getTime() - 26 * HOUR), discordMessageId: "1300000000000000901" }),
    post(2, { content: postBody({ text: "Which night works for the next practice?", poll: { question: "Practice night?", answers: ["Tuesday", "Wednesday", "Thursday"], hours: 48 } }), status: "SCHEDULED", scheduledFor: new Date(now.getTime() + 30 * HOUR) }),
    post(3, { channelId: FAKE_CHANNELS.general, content: postBody({ text: "LSC Round 3 recap is up on the site." }), status: "FAILED", scheduledFor: new Date(now.getTime() - 3 * HOUR), error: "The bot isn't allowed to post in the channel (Discord: Missing Permissions)." }),
    post(4, { content: postBody({ text: "Old draft about parking" }), status: "CANCELLED", scheduledFor: new Date(now.getTime() - 50 * HOUR), error: "Cancelled by an officer." }),
  ];
  for (const data of rows) {
    const id = randomUUID();
    await prisma.discordPost.create({ data: { ...data, id, nonce: postNonce(id) } });
  }

  const mirror = await runEventMirror(writer, { now, log: (line) => console.log(`  mirror: ${line}`) });
  // There were none before (checked above): every row now is this run's
  const mirrored = await prisma.discordEventMirror.findMany();
  await writeSaved({ ...((await readSaved()) ?? saved), mirrors: mirrored.map((m) => m.discordEventId) });
  for (const [i, m] of mirrored.entries()) await fetch(`${FAKES_ORIGIN}/discord/_fake/interested`, { method: "POST", body: JSON.stringify({ eventId: m.discordEventId, count: 4 + i * 3 }) });
  await runEventMirror(writer, { now, log: () => {} });
  console.log(`Mirrored ${mirror.created} upcoming public events to the fake's Events list, with interested counts.`);

  await prisma.discordRoleRule.create({ data: { id: ROLE_RULE, roleId: FAKE_DISCORD.roles.lscDriver, condition: "lsc_driver", enabled: false, createdById: officer?.id ?? null } });
  console.log("Added a role sync rule (LSC Driver for the LSC Driver badge, off).");
  console.log("\nOpen /admin/announcements and /admin/discord. Remove it all with --clean.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
