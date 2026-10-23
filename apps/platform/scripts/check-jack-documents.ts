/**
 * Checks the documents track (#188: Drive, SharePoint, Teams) against the LOCAL database: what the unit
 * tests can't see, because it lives in Postgres.
 *
 *   - the ExternalDocument store: upsert, touch, remove (text dropped), the walk's reconcile, BigInt sizes
 *   - the search index triggers on ExternalDocument and TeamsMessage, and the Knowledge tabs' searches
 *     (the `= ANY(...::text[])` filter, full text plus plain matches on names, folders and authors)
 *   - the Teams store: channels, messages, purges, dropping a channel (its messages go, in one transaction)
 *   - the GraphSubscription store
 *   - the whole Drive sync and SharePoint sync against their fakes, run in this process on a free port,
 *     into throwaway sources
 *   - the documents reader refusing a source whose connector is off (read only: ConnectorState is never written)
 *
 *   cd apps/platform
 *   NODE_ENV=production pnpm exec tsx scripts/check-jack-documents.ts
 *
 * Refuses to run unless DATABASE_URL points at 127.0.0.1 or localhost. It writes only rows it creates
 * (sources and ids tagged with one random word) and deletes them at the end, pass or fail.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
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
  const tag = randomBytes(4).toString("hex");
  const docSource = `check-docs-${tag}`;
  const driveSource = `check-drive-${tag}`;
  const spSource = `check-sp-${tag}`;
  const channelA = `19:check-a-${tag}@thread.tacv2`;
  const channelB = `19:check-b-${tag}@thread.tacv2`;
  const subscriptionId = `check-sub-${tag}`;

  const { prisma } = await import("../src/server/db");
  const { prismaDocumentStore } = await import("../src/server/connectors/documents/store");
  const { prismaTeamsStore, prismaSubscriptionStore } = await import("../src/server/connectors/teams/store");
  const { listDocuments, listTeamsMessages } = await import("../src/server/queries/documents");
  const { documentsSource } = await import("../src/server/jack/search/sources/documents");
  const { startFakeServer } = await import("../src/server/connectors/fakes/server");
  const { googleDriveFake } = await import("../src/server/connectors/google-drive/fake/handlers");
  const { microsoftGraphFake } = await import("../src/server/connectors/microsoft/fake/handlers");

  const indexed = async (source: string, id: string, word: string) => {
    const [row] = await prisma.$queryRaw<{ hit: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "JackSearchDoc" WHERE source = ${source} AND "sourceId" = ${id} AND search @@ websearch_to_tsquery('english', ${word})) AS hit`;
    return row?.hit === true;
  };

  const server = await startFakeServer({ services: [googleDriveFake, microsoftGraphFake], port: 0 });
  try {
    // ---- The document store ----
    const store = prismaDocumentStore(docSource);
    const meta = { externalId: `a-${tag}`, name: `Budget ${tag}.xlsx`, path: "/Finance", mimeType: "text/plain", webUrl: "https://drive.google.com/open?id=a", modifiedAt: new Date(), sizeBytes: 3_000_000_000, version: "1" };
    const t0 = new Date();
    await store.save(meta, { text: `The showcase budget is 400 dollars ${tag}word`, textStatus: "ok" }, t0);
    const saved = await prisma.externalDocument.findFirst({ where: { source: docSource } });
    check("a saved document gets its row, a BigInt size over 2^31 included", saved?.sizeBytes === BigInt(3_000_000_000) && saved.textStatus === "ok");
    check("the trigger indexes its text", saved ? await indexed("document", saved.id, `${tag}word`) : false);
    const listed = await listDocuments({ q: `${tag}word`, sources: [docSource] });
    check("the Documents tab finds it by a word of its text (the ::text[] source filter binds)", listed.rows.some((row) => row.id === saved?.id), `${listed.total} found`);
    check("…and by part of its name", (await listDocuments({ q: `budget ${tag.slice(0, 4)}`, sources: [docSource] })).rows.length === 1);
    check("…and not under another source", (await listDocuments({ q: `${tag}word`, sources: ["drive-none"] })).total === 0);
    check("the per-source count", (await listDocuments({ sources: [docSource] })).counts[docSource] === 1);

    await store.touch({ ...meta, name: `Budget ${tag} renamed.xlsx`, path: "/Money" }, new Date());
    const touched = await prisma.externalDocument.findFirst({ where: { source: docSource } });
    check("touch changes the name and folder, keeps the text", touched?.name.endsWith("renamed.xlsx") === true && touched.path === "/Money" && touched.text?.includes("400 dollars") === true);

    check("remove marks it deleted and drops its text", (await store.remove(meta.externalId, new Date())) && (await prisma.externalDocument.findFirst({ where: { source: docSource } }))?.text === null);
    check("…once", !(await store.remove(meta.externalId, new Date())));
    check("…and the Documents tab no longer lists it", (await listDocuments({ q: `${tag}word`, sources: [docSource] })).total === 0);

    await store.save({ ...meta, externalId: `old-${tag}` }, { text: "old", textStatus: "ok" }, new Date(Date.now() - 86_400_000));
    await store.save({ ...meta, externalId: `new-${tag}` }, { text: "new", textStatus: "ok" }, new Date());
    check("the reconcile removes only what the walk didn't see", (await store.removeUnseen(new Date(Date.now() - 3_600_000), new Date())) === 1);

    // ---- The reader, against whatever ConnectorState says (never written here) ----
    const driveOn = (await prisma.connectorState.findUnique({ where: { id: "google-drive" } }))?.enabled ?? false;
    const readerRow = await prisma.externalDocument.create({ data: { source: "drive", externalId: `check-reader-${tag}`, name: "Reader check", path: "/", mimeType: "text/plain", webUrl: "https://drive.google.com/open?id=x", modifiedAt: new Date(), text: "hello", textStatus: "ok", syncedAt: new Date() } });
    const read = await documentsSource.readers[0].read(readerRow.id, {});
    check(driveOn ? "the reader opens a Drive document while Drive is on" : "the reader refuses a Drive document while Drive is off", driveOn ? read.ok : !read.ok && read.error.includes("isn't connected"));

    // ---- Teams ----
    const teams = prismaTeamsStore();
    await teams.saveChannel({ id: channelA, teamId: `team-${tag}`, name: `check-${tag}` }, new Date());
    await teams.saveChannel({ id: channelB, teamId: `team-${tag}`, name: `check-b-${tag}` }, new Date());
    await teams.setDeltaLink(channelA, `https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta?$deltatoken=${tag}`, new Date());
    check("a channel keeps its delta link exactly", (await teams.channel(channelA))?.deltaLink?.endsWith(`$deltatoken=${tag}`) === true);
    const message = { id: `m-${tag}`, channelId: channelA, replyToId: null, authorAadId: null, authorName: "Fixture Officer", content: `The sponsor call ${tag}call is Thursday`, createdAt: new Date(), editedAt: null, deletedAt: null };
    await teams.saveMessage(message);
    await teams.saveMessage({ ...message, id: `r-${tag}`, replyToId: message.id, content: `Reply ${tag}reply` });
    await teams.saveMessage({ ...message, id: `b-${tag}`, channelId: channelB, content: "in channel b" });
    check("the trigger indexes a Teams message", await indexed("teams", message.id, `${tag}call`));
    const found = await listTeamsMessages({ q: `${tag}call` });
    check("the Teams tab finds it by text, with its channel's name", found.rows.some((row) => row.id === message.id && row.channelName === `check-${tag}`));
    check("…and filters by channel", (await listTeamsMessages({ q: `${tag}call`, channelId: channelB })).total === 0);
    check("purging drops the text and keeps who and when", (await teams.purgeMessage(message.id, new Date())) && (await prisma.teamsMessage.findUnique({ where: { id: message.id } }))?.content === "");
    check("…and the Teams tab no longer lists it", (await listTeamsMessages({ q: `${tag}call` })).total === 0);
    const everyChannel = (await prisma.teamsChannel.findMany({ select: { id: true } })).map((c) => c.id).filter((id) => id !== channelB);
    const dropped = await teams.dropOtherChannels(everyChannel);
    check("dropping a channel unsyncs it and deletes its messages, nothing else", dropped.channels === 1 && dropped.messages === 1 && (await prisma.teamsMessage.count({ where: { channelId: channelA } })) === 2, JSON.stringify(dropped));

    // ---- Subscriptions ----
    const subscriptions = prismaSubscriptionStore();
    await subscriptions.save({ id: subscriptionId, resource: `/teams/x/channels/${channelA}/messages`, expiresAt: new Date(Date.now() + 3_600_000), clientStateHash: "a".repeat(64) });
    await subscriptions.save({ id: subscriptionId, resource: `/teams/x/channels/${channelA}/messages`, expiresAt: new Date(Date.now() + 7_200_000), clientStateHash: "a".repeat(64) });
    check("a subscription saves and renews in place", ((await subscriptions.find(subscriptionId))?.expiresAt.getTime() ?? 0) > Date.now() + 3_700_000);
    await subscriptions.remove(subscriptionId);
    check("…and is removed", (await subscriptions.find(subscriptionId)) === null);

    // ---- The real syncs against their fakes, into throwaway sources ----
    process.env.JACK_FAKES = "google-drive,microsoft-graph";
    process.env.JACK_FAKES_URL = server.url;
    const { driveClient } = await import("../src/server/connectors/google-drive/client");
    const { syncDrive } = await import("../src/server/connectors/google-drive/sync");
    const { DRIVE_FAKE_ROOT_ID, DRIVE_FAKE_SA_EMAIL } = await import("../src/server/connectors/google-drive/fake/fixtures");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const drive = await syncDrive({ client: driveClient({ email: DRIVE_FAKE_SA_EMAIL, privateKey }), rootId: DRIVE_FAKE_ROOT_ID, store: prismaDocumentStore(driveSource), cursor: null, signal: AbortSignal.timeout(120_000), deadline: Date.now() + 120_000 });
    const driveRows = await prisma.externalDocument.findMany({ where: { source: driveSource, deletedAt: null }, select: { id: true, name: true, textStatus: true } });
    check("the Drive sync fills the table from the fake folder", driveRows.length === 11 && !drive.more, `${driveRows.length} documents`);
    const pdf = driveRows.find((row) => row.name === "Venue Contract.pdf");
    check("…a PDF's text is searchable through the trigger", pdf ? await indexed("document", pdf.id, "deposit") : false);
    check("…a restricted file is kept without text", driveRows.some((row) => row.name === "Signed Agreement.pdf" && row.textStatus === "restricted"));
    const again = await syncDrive({ client: driveClient({ email: DRIVE_FAKE_SA_EMAIL, privateKey }), rootId: DRIVE_FAKE_ROOT_ID, store: prismaDocumentStore(driveSource), cursor: drive.cursor, signal: AbortSignal.timeout(60_000), deadline: Date.now() + 60_000 });
    check("…and a second run reads nothing again", again.counts.indexed === 0);

    const { graphClient } = await import("../src/server/connectors/microsoft/graph");
    const { syncSharePoint } = await import("../src/server/connectors/sharepoint/sync");
    const { GRAPH_FAKE } = await import("../src/server/connectors/microsoft/fake/fixtures");
    const graph = graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret });
    const library = await syncSharePoint({ graph, driveId: GRAPH_FAKE.driveId, store: prismaDocumentStore(spSource), cursor: null, signal: AbortSignal.timeout(60_000), deadline: Date.now() + 60_000 });
    const transcript = await prisma.externalDocument.findFirst({ where: { source: spSource, name: "Officer meeting.vtt" }, select: { text: true, externalId: true } });
    check("the SharePoint sync stores a transcript speaker-tagged, keyed driveId!itemId", transcript?.text?.startsWith("[0:02] Fixture Officer A:") === true && transcript.externalId === `${GRAPH_FAKE.driveId}!sp-transcript` && !library.more);
  } finally {
    await prisma.externalDocument.deleteMany({ where: { OR: [{ source: { in: [docSource, driveSource, spSource] } }, { externalId: `check-reader-${tag}` }] } });
    await prisma.teamsMessage.deleteMany({ where: { channelId: { in: [channelA, channelB] } } });
    await prisma.teamsChannel.deleteMany({ where: { id: { in: [channelA, channelB] } } });
    await prisma.graphSubscription.deleteMany({ where: { id: subscriptionId } });
    const [left] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "JackSearchDoc" d WHERE (d.source = 'document' AND NOT EXISTS (SELECT 1 FROM "ExternalDocument" e WHERE e.id = d."sourceId")) OR (d.source = 'teams' AND NOT EXISTS (SELECT 1 FROM "TeamsMessage" t WHERE t.id = d."sourceId"))`;
    check("cleaned up: no search rows left for deleted documents or messages", left?.n === 0, `${left?.n ?? "?"} left`);
    await server.close();
    await prisma.$disconnect();
  }
  if (failed) {
    console.error("\nSome checks failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
