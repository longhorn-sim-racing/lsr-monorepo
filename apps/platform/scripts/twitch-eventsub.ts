/**
 * Twitch EventSub setup (Jack 2.0, design §12.2): subscribes the club channel's stream.online and
 * stream.offline to /api/webhooks/twitch. It PRINTS what it will do; nothing changes without --apply.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts            # show what Twitch has and the plan
 *   pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts --apply    # create what's missing, replace failed ones
 *   pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts --remove --apply   # delete ours (before deleting the Twitch app)
 *
 *   --callback=<url>   default https://www.longhornsimracing.org/api/webhooks/twitch, the only one allowed without --local
 *   --local            allows any callback: a local dev server against the fakes (JACK_FAKES=twitch, `pnpm jack:fakes`),
 *                      e.g. --local --callback=http://localhost:3000/api/webhooks/twitch, or an https tunnel
 *
 * Needs TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_BROADCASTER_ID and TWITCH_EVENTSUB_SECRET, from the
 * environment or apps/platform/.env.local / .env. The webhook must already be deployed with the same
 * TWITCH_EVENTSUB_SECRET: Twitch sends a signed challenge right after each subscription is made, and only
 * a correct answer enables it. Never prints a secret or a token.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LOCAL = args.includes("--local");
const REMOVE = args.includes("--remove");

async function main() {
  const { missingEnv } = await import("../src/server/connectors/define");
  const { fakesEnabledFor } = await import("../src/server/connectors/base-url");
  const { twitchAppApi } = await import("../src/server/connectors/twitch/connector");
  const setup = await import("../src/server/connectors/twitch/eventsub-setup");

  const missing = missingEnv(["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BROADCASTER_ID", "TWITCH_EVENTSUB_SECRET"]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}.`);
    process.exit(1);
  }
  const secret = process.env.TWITCH_EVENTSUB_SECRET!;
  if (secret.length < 10 || secret.length > 100) {
    console.error("TWITCH_EVENTSUB_SECRET must be 10 to 100 characters (make one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\").");
    process.exit(1);
  }
  const callback = args.find((a) => a.startsWith("--callback="))?.slice("--callback=".length) ?? setup.PRODUCTION_CALLBACK;
  const problem = setup.callbackProblem(callback, { local: LOCAL });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID!;
  const target = fakesEnabledFor("twitch") ? "the Twitch FAKE (JACK_FAKES)" : "the REAL Twitch";

  const api = twitchAppApi();
  const { access_token: token } = await api.mintAppToken();
  const before = await setup.listSubscriptions(api, token, broadcasterId);
  console.log(`Twitch EventSub for channel ${broadcasterId}, on ${target}. Callback: ${callback}`);
  console.log(`Subscriptions now (cost ${before.totalCost} of ${before.maxTotalCost}):`);
  for (const sub of before.subscriptions) console.log(`  ${sub.type.padEnd(15)} ${sub.status.padEnd(40)} ${sub.callback}`);
  if (!before.subscriptions.length) console.log("  (none)");

  const plan = REMOVE
    ? { keep: [], remove: before.subscriptions.filter((s) => s.callback === callback), create: [], elsewhere: before.subscriptions.filter((s) => s.callback !== callback) }
    : setup.planSubscriptions(before.subscriptions, callback, broadcasterId);
  console.log("\nPlan:");
  for (const sub of plan.keep) console.log(`  keep    ${sub.type} (${sub.status})`);
  for (const sub of plan.remove) console.log(`  delete  ${sub.type} (${sub.status})`);
  for (const type of plan.create) console.log(`  create  ${type}`);
  for (const sub of plan.elsewhere) console.log(`  leave   ${sub.type} to ${sub.callback} (another callback; delete it in the Twitch console or with this script's --callback if it's stale)`);
  if (!plan.remove.length && !plan.create.length) {
    console.log("\nNothing to do.");
    return;
  }
  if (!APPLY) {
    console.log("\nNothing changed. Run again with --apply to do this.");
    return;
  }

  const done = await setup.applySubscriptionPlan(api, token, plan, { callback, secret, broadcasterId });
  console.log(`\nDeleted ${done.removed}, created ${done.created.length}${done.created.length ? ` (${done.created.join(", ")})` : ""}.`);
  if (!done.created.length) return;

  // Twitch sends each new subscription a challenge; wait until it's answered (enabled) or refused
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const now = (await setup.listSubscriptions(api, token, broadcasterId)).subscriptions.filter((s) => s.callback === callback);
    if (now.every((s) => s.status !== "webhook_callback_verification_pending")) {
      for (const sub of now) console.log(`  ${sub.type.padEnd(15)} ${sub.status}`);
      if (now.some((s) => s.status !== "enabled")) {
        console.error("\nA subscription isn't enabled: check the webhook is deployed at the callback with the same TWITCH_EVENTSUB_SECRET, and see the function log for \"[twitch] Refused\".");
        process.exit(1);
      }
      console.log("\nBoth subscriptions are enabled.");
      return;
    }
  }
  console.log("\nStill waiting for Twitch's challenge to be answered; run the script again (without --apply) in a minute to see the statuses.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
