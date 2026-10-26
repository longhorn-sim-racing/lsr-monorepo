import type { EvalSeeder } from "./types";

/** The standing rule the eval copy gets (a fixed id, so a rerun resets it) */
export const EVAL_REMINDER_RULE_ID = "e7a1d15c-0000-4000-8000-00000000d801";

/**
 * Fills the eval copy with the discord-post track's fake data before a run (pnpm jack:eval:prepare),
 * after discord-read's seeder synced the Discord fake's channels: the fake's #announcements and #general
 * as posting channels, and one standing rule (event reminders a day before, on). Writes only fake data
 * (the fake server's channel ids), and resets the rule on every run.
 */
export const SEEDERS: EvalSeeder[] = [
  {
    name: "discord-post: posting channels and a standing rule",
    async run({ prisma, log }) {
      const { FAKE_CHANNELS } = await import("../../../src/server/connectors/discord/fake/data");
      const { POSTING_SETTING } = await import("../../../src/server/discord-post/channels");
      const wanted = [FAKE_CHANNELS.announcements, FAKE_CHANNELS.general];
      const found = await prisma.discordChannel.findMany({ where: { id: { in: wanted } }, select: { id: true } });
      if (found.length !== wanted.length) {
        log("The Discord fake's channels aren't in the eval copy (did the discord-read seeder run?); skipped.");
        return "skipped: no synced Discord channels";
      }
      const value = JSON.stringify({ channels: wanted });
      await prisma.systemSetting.upsert({ where: { key: POSTING_SETTING }, update: { value }, create: { key: POSTING_SETTING, value } });
      const rule = { kind: "event_reminder", channelId: FAKE_CHANNELS.announcements, config: { offsets: [1440], series: null, ping: null }, enabled: true, cutoffAt: new Date() };
      await prisma.discordRule.upsert({ where: { id: EVAL_REMINDER_RULE_ID }, update: rule, create: { id: EVAL_REMINDER_RULE_ID, ...rule } });
      return "posting channels #announcements and #general; one event reminder rule (1 day before, on)";
    },
  },
];
