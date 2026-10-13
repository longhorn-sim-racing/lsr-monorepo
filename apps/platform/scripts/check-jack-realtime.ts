/**
 * Checks Jack's private room channels against the LOCAL Supabase stack (#161):
 *
 *   (a) a signed-out (anon) client can't join a `jack:room:*` private channel, and hears nothing
 *       (nor does it by joining the same topic as a public channel)
 *   (b) a signed-in member who isn't an officer can't join
 *   (c) a signed-in officer can
 *   (d) two officers both receive the same reply, streamed by the server
 *   plus: officers can't broadcast into a room themselves, presence shows both officers, and the
 *   officer check still works with schema public locked down the way production has it
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-realtime.ts
 *
 * Refuses to run unless NEXT_PUBLIC_SUPABASE_URL and DATABASE_URL point at 127.0.0.1/localhost.
 * Creates throwaway users (random passwords, never printed) and a room, and deletes them at the end.
 * The reply comes from the scripted fake Claude (src/server/jack/fake-claude.ts), passed in through the
 * reply loop's deps, so it never calls the Anthropic API (with or without ANTHROPIC_API_KEY) and
 * always streams a few seconds of text in many deltas.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { JackRoomEvent } from "../src/lib/jack/types";

// ---------------------------------------------------------------------------
// env: load .env.local / .env without overriding what's already set
// ---------------------------------------------------------------------------
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
function hostOf(url: string | undefined) {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]) {
  const host = hostOf(process.env[name]);
  if (!LOCAL_HOSTS.includes(host)) {
    console.error(`Refusing to run: ${name} points at "${host || "nothing"}", not the local Supabase stack.`);
    process.exit(1);
  }
}
for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name}. Local values come from \`npx supabase status -o env\`.`);
    process.exit(1);
  }
}
// db.ts logs every query unless NODE_ENV is production; keep the run readable.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JOIN_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_500;

let failed = false;
function check(step: string, ok: boolean, note?: string) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${note ? `  (${note})` : ""}`);
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Person = { key: string; email: string; password: string; displayName: string; officer: boolean; id?: string };

type Listener = {
  channel: RealtimeChannel;
  events: JackRoomEvent[];
  /** How the join ended: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT or NO_REPLY */
  joined: Promise<{ status: string; error?: string }>;
  presenceIds: () => string[];
};

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const { prisma } = await import("../src/server/db");
  const { postOfficerMessage } = await import("../src/server/jack/rooms");
  const { defaultReplyDeps } = await import("../src/server/jack/reply-loop");
  const { fakeClaude } = await import("../src/server/jack/fake-claude");
  const { JACK_EVENT, jackRoomTopic } = await import("../src/lib/jack/types");

  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, noSession);
  const tag = `jack-check-${Date.now().toString(36)}`;
  const people: Person[] = [
    { key: "officer-a", displayName: "Check Officer A", officer: true },
    { key: "officer-b", displayName: "Check Officer B", officer: true },
    { key: "member", displayName: "Check Member", officer: false },
  ].map((p) => ({ ...p, email: `${tag}-${p.key}@example.com`, password: randomBytes(24).toString("base64url") }));
  const clients: SupabaseClient[] = [];
  let roomId: string | null = null;

  const listen = (client: SupabaseClient, topic: string, opts: { isPrivate: boolean; presenceKey?: string }): Listener => {
    const channel = client.channel(topic, {
      config: { private: opts.isPrivate, ...(opts.presenceKey ? { presence: { key: opts.presenceKey } } : {}) },
    });
    const events: JackRoomEvent[] = [];
    for (const event of Object.values(JACK_EVENT)) {
      channel.on("broadcast", { event }, ({ payload }) => events.push(payload as JackRoomEvent));
    }
    let presenceIds: string[] = [];
    if (opts.presenceKey) {
      channel.on("presence", { event: "sync" }, () => {
        presenceIds = Object.values(channel.presenceState<{ userId: string }>())
          .map((metas) => metas[0]?.userId)
          .filter(Boolean)
          .sort();
      });
    }
    const joined = new Promise<{ status: string; error?: string }>((done) => {
      const timer = setTimeout(() => done({ status: "NO_REPLY" }), JOIN_TIMEOUT_MS);
      channel.subscribe((status, err) => {
        if (status === "CLOSED") return;
        clearTimeout(timer);
        done({ status, error: err?.message });
      });
    });
    return { channel, events, joined, presenceIds: () => presenceIds };
  };

  try {
    // ---- throwaway users, a room -------------------------------------------------
    const officerRole = await prisma.role.findUnique({ where: { key: "officer" } });
    if (!officerRole) throw new Error('No "officer" role in the local database; run the seed first.');

    for (const person of people) {
      const { data, error } = await admin.auth.admin.createUser({
        email: person.email,
        password: person.password,
        email_confirm: true,
        user_metadata: { full_name: person.displayName },
      });
      if (error || !data.user) throw new Error(`Couldn't create test user ${person.key}: ${error?.message}`);
      person.id = data.user.id;
      await prisma.user.create({
        data: { id: person.id, email: person.email, handle: `${tag}-${person.key}`, displayName: person.displayName },
      });
      if (person.officer) await prisma.userRole.create({ data: { userId: person.id, roleId: officerRole.id } });
    }
    const [officerA, officerB, member] = people;
    const room = await prisma.jackRoom.create({ data: { createdById: officerA.id!, title: tag } });
    roomId = room.id;
    const topic = jackRoomTopic(room.id);

    const signIn = async (person: Person) => {
      const client = createClient(SUPABASE_URL, ANON_KEY, noSession);
      clients.push(client);
      const { error } = await client.auth.signInWithPassword({ email: person.email, password: person.password });
      if (error) throw new Error(`Couldn't sign in ${person.key}: ${error.message}`);
      await client.realtime.setAuth();
      return client;
    };
    const anonClient = createClient(SUPABASE_URL, ANON_KEY, noSession);
    clients.push(anonClient);
    await anonClient.realtime.setAuth();

    // ---- (a), (b), (c): who can join -------------------------------------------
    const anonPrivate = listen(anonClient, topic, { isPrivate: true });
    const memberPrivate = listen(await signIn(member), topic, { isPrivate: true });
    const clientA = await signIn(officerA);
    const clientB = await signIn(officerB);
    const a = listen(clientA, topic, { isPrivate: true, presenceKey: officerA.id });
    const b = listen(clientB, topic, { isPrivate: true, presenceKey: officerB.id });

    const anonJoin = await anonPrivate.joined;
    check("(a) signed-out client can't join the private room channel", anonJoin.status !== "SUBSCRIBED", anonJoin.status);
    const memberJoin = await memberPrivate.joined;
    check("(b) signed-in non-officer can't join", memberJoin.status !== "SUBSCRIBED", memberJoin.status);
    const aJoin = await a.joined;
    const bJoin = await b.joined;
    check("(c) signed-in officer can join", aJoin.status === "SUBSCRIBED", aJoin.status);
    check("(c) a second officer can join", bJoin.status === "SUBSCRIBED", bJoin.status);

    // Same topic as a public channel: it may join (local allows public channels), but must hear nothing.
    // Its own client, since supabase-js keeps one channel per topic per client
    const anonPublicClient = createClient(SUPABASE_URL, ANON_KEY, noSession);
    clients.push(anonPublicClient);
    const anonPublic = listen(anonPublicClient, topic, { isPrivate: false });
    const anonPublicJoin = await anonPublic.joined;

    // ---- presence ----------------------------------------------------------------
    await a.channel.track({ userId: officerA.id, displayName: officerA.displayName });
    await b.channel.track({ userId: officerB.id, displayName: officerB.displayName });
    const bothIds = [officerA.id!, officerB.id!].sort();
    for (let i = 0; i < 20 && a.presenceIds().join() !== bothIds.join(); i++) await wait(250);
    check("presence: each officer sees both in the room", a.presenceIds().join() === bothIds.join() && b.presenceIds().join() === bothIds.join());

    // ---- officers can't broadcast from the browser -------------------------------
    await a.channel.send({
      type: "broadcast",
      event: JACK_EVENT.delta,
      payload: { type: JACK_EVENT.delta, messageId: "forged", seq: 1, text: "forged" },
    });

    // ---- (d): a reply streamed by the server reaches both officers ---------------
    // A scripted reply, streamed in small pieces about 40 ms apart (~2 s, so ~13 deltas of ~150 ms each).
    // Never the real API: no key needed, nothing spent
    const fake = fakeClaude(
      [{ text: `Check reply: there are 13 LSC applications this season, 9 of them paid. ${"This sentence is here so the reply streams for a while. ".repeat(4)}` }],
      undefined,
      { chunkSize: 6, chunkDelayMs: 40 }
    );
    const replyDeps = {
      ...defaultReplyDeps,
      getClient: () => fake.client,
      budget: async () => ({ month: "check", spentUsd: 0, budgetUsd: 1 }),
    };
    // Outside a request, the after-response work runs inline: this returns once the reply is done
    const question = await postOfficerMessage(room.id, officerA.id!, "Check: how many LSC applications are there?", replyDeps);
    if (!question) throw new Error("Posting the question failed");
    await wait(SETTLE_MS);

    const saved = await prisma.jackMessage.findFirst({ where: { roomId: room.id, kind: "assistant" } });
    check("(d) the server saved a finished reply", saved?.status === "done", saved?.status ?? "no reply");
    check("(d) the reply came from the fake Claude, not the API", fake.calls.length === 1 && Boolean(saved?.content.startsWith("Check reply:")), `${fake.calls.length} fake call(s)`);

    for (const [name, listener] of [["officer A", a], ["officer B", b]] as const) {
      const created = listener.events.filter((e) => e.type === JACK_EVENT.created);
      const deltas = listener.events.filter((e) => e.type === JACK_EVENT.delta && e.messageId === saved?.id);
      const done = listener.events.find((e) => e.type === JACK_EVENT.done && e.message.id === saved?.id);
      const seqs = deltas.map((d) => (d.type === JACK_EVENT.delta ? d.seq : 0));
      const text = deltas.map((d) => (d.type === JACK_EVENT.delta ? d.text : "")).join("");
      check(
        `(d) ${name} got the question and the reply as they were created`,
        created.some((e) => e.type === JACK_EVENT.created && e.message.id === question.id) &&
          created.some((e) => e.type === JACK_EVENT.created && e.message.id === saved?.id)
      );
      check(
        `(d) ${name} got the reply as deltas 1..${seqs.length}, in order`,
        seqs.length > 5 && seqs.every((seq, i) => seq === i + 1),
        `${seqs.length} deltas`
      );
      check(`(d) ${name}'s deltas add up to the saved reply`, Boolean(saved) && text === saved?.content);
      check(
        `(d) ${name} got the done event with the full reply`,
        done?.type === JACK_EVENT.done && done.message.status === "done" && done.message.content === saved?.content
      );
      check(`officers can't broadcast: ${name} never heard the forged delta`, !listener.events.some((e) => e.type === JACK_EVENT.delta && e.messageId === "forged"));
    }
    check(
      "(d) both officers received the same events in the same order",
      JSON.stringify(a.events) === JSON.stringify(b.events) && a.events.length > 0,
      `${a.events.length} events each`
    );

    check("(a) signed-out client heard nothing", anonPrivate.events.length === 0, `${anonPrivate.events.length} events`);
    check(
      "(a) signed-out client on the same topic as a public channel heard nothing",
      anonPublic.events.length === 0,
      `public join: ${anonPublicJoin.status}, ${anonPublic.events.length} events`
    );
    check("(b) non-officer heard nothing", memberPrivate.events.length === 0, `${memberPrivate.events.length} events`);

    // ---- the officer check with schema public locked down as in production -------
    // Production's anon/authenticated have no usage on schema public. Revoke it here inside a
    // transaction that always rolls back, and ask the officer check as each kind of user.
    const ROLLBACK = new Error("rollback");
    const asUser = (sub: string) => JSON.stringify({ sub, role: "authenticated" });
    const lockedDown = { publicUsage: true, officer: false, member: true };
    try {
      await prisma.$transaction(async (tx) => {
        const ask = async (sql: string) => (await tx.$queryRawUnsafe<{ ok: boolean }[]>(sql))[0].ok;
        await tx.$executeRawUnsafe("REVOKE USAGE ON SCHEMA public FROM PUBLIC, anon, authenticated");
        await tx.$executeRawUnsafe("SET LOCAL ROLE authenticated");
        lockedDown.publicUsage = await ask("SELECT has_schema_privilege('public', 'usage') AS ok");
        await tx.$queryRawUnsafe("SELECT set_config('request.jwt.claims', $1, true)", asUser(officerA.id!));
        lockedDown.officer = await ask("SELECT jack_private.is_officer() AS ok");
        await tx.$queryRawUnsafe("SELECT set_config('request.jwt.claims', $1, true)", asUser(member.id!));
        lockedDown.member = await ask("SELECT jack_private.is_officer() AS ok");
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
    check(
      "officer check works without usage on schema public (as in production)",
      !lockedDown.publicUsage && lockedDown.officer && !lockedDown.member,
      JSON.stringify(lockedDown)
    );
    const [grants] = await prisma.$queryRawUnsafe<{ anon_exec: boolean; anon_usage: boolean; auth_exec: boolean }[]>(
      `SELECT has_function_privilege('anon', 'jack_private.is_officer()', 'execute') AS anon_exec,
              has_schema_privilege('anon', 'jack_private', 'usage') AS anon_usage,
              has_function_privilege('authenticated', 'jack_private.is_officer()', 'execute') AS auth_exec`
    );
    check("only authenticated can call the officer check", !grants.anon_exec && !grants.anon_usage && grants.auth_exec, JSON.stringify(grants));
  } finally {
    // ---- clean up ----------------------------------------------------------------
    for (const client of clients) await client.removeAllChannels().catch(() => {});
    if (roomId) await prisma.jackRoom.delete({ where: { id: roomId } }).catch((e) => console.error("Cleanup: room", e));
    for (const person of people) {
      if (!person.id) continue;
      await prisma.user.delete({ where: { id: person.id } }).catch((e) => console.error(`Cleanup: user ${person.key}`, e));
      const { error } = await admin.auth.admin.deleteUser(person.id);
      if (error) console.error(`Cleanup: auth user ${person.key}: ${error.message}`);
    }
    await prisma.$disconnect();
  }

  console.log(failed ? "\nSome checks FAILED." : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
