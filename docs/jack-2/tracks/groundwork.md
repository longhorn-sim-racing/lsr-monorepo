Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Connectors, HTTP fakes and the Connections page (G2)

Every outside service goes through the same shape, so Jack's tools, the sync jobs and the admin pages handle "not connected" the same way (design §12, principles 8 to 11). That covers Discord, Twitch, Stripe, Resend, site traffic, Instagram, Google Drive, Microsoft Graph and Supabase Storage.

### What's where (`apps/platform/src/server/connectors/`)
- `types.ts`: the `Connector` interface and `ConnectorStatus` (from G1). `smoke()` now takes `{ signal }`.
- `define.ts`:
  - `defineConnector()` builds a `Connector` from its parts.
  - Also `missingEnv()`, `buildConnectorStatus()` and `CONNECTOR_ID`.
- `state.ts`: the `ConnectorState` row.
  - `connectorEnabled(id)`: a missing row reads as off.
  - `setConnectorEnabled(id, enabled, { userId })`: the caller checks the admin role. It writes an audit entry (entityType `CONNECTOR`, `ENABLE` or `DISABLE`) only when the value changes.
  - `recordConnectorSync(id, { cursor? })`: stamps `lastSyncAt`. The cursor is stored exactly as given; leaving it out keeps the stored one, and `null` clears it.
  - `recordConnectorError(id, error)`: stores the error through `redactSecrets()` and returns the stored text.
  - `readConnectorState(id)`.
- `status.ts`:
  - `connectorStatus(id)`.
  - `listConnections()`: the page's rows.
  - `runConnectorSmoke(connector)`: a 25 s timeout that aborts the test's signal, a redacted summary of at most 300 characters, and it never throws.
- `base-url.ts`: `serviceBaseUrl()`, `serviceFetch()` (for SDKs that take only a host) and the `JACK_FAKES` switch.
- `fakes/`: the fake framework (below).
- `example/`: the template service (a fake, a client, a connector and its test). It's never registered as a connector, so it doesn't show on the page.

### Adding a connector
1. **Use the seeded id.** G1 seeded a `ConnectorState` row, switched off, for each planned connector: `discord`, `twitch`, `stripe`, `resend`, `site-traffic`, `instagram-insights`, `instagram-publish`, `google-drive`, `sharepoint`, `teams`. A new id gets its row (still off) on its first write.
2. **Write the client** with plain `fetch` (or the SDK) against `serviceBaseUrl("<service>", "<real base URL>")`. An SDK that takes only a host gets `serviceFetch()` instead (see "SDK notes" below).
   - Put a timeout on every call, and keep it when the caller passes a signal (`AbortSignal.any()`, as `example/client.ts` does).
   - Errors carry the status and path, never the key.
   - If the client already has its own override env var, pass it as the real URL: `serviceBaseUrl("instagram", process.env.INSTAGRAM_GRAPH_URL || "https://graph.instagram.com")`.
3. **Wrap it in `defineConnector({ id, label, requiredEnv, missingSettings?, createClient, smoke?, details? })`.**
   - `client()` returns null unless the env is set, an admin switched it on and its settings are saved. Callers turn null into "not connected".
   - `smoke()` must work while the connector is switched off: build the client directly instead of calling `client()`.
   - `details()` adds lines to the page (never a secret).
4. **Register it** in `connectors/slots/<track>.ts`. Never import the registry from a slot file: `joinSlots` throws on that import cycle.
5. **Record each sync.** Sync jobs call `recordConnectorSync` and `recordConnectorError`.
   - **Cursors never hold a credential.** They're stored as is and never redacted, because redaction would break page tokens and delta links.
   - Error and summary text always goes through `redactSecrets()`; `recordConnectorError` does that.
6. **Keep status out of the prompt.** Connector status never goes into Jack's system prompt; only tool results say "not connected".

### HTTP fakes
- **Turning them on:**
  - `JACK_FAKES=all`, or a comma list such as `discord,twitch`, points those services' clients at the fakes server.
  - `JACK_FAKES_URL` says where that server is. It defaults to `http://127.0.0.1:3999` and must be plain http on this machine (127.0.0.1, localhost or [::1]), because a client in fake mode still sends whatever key is in env.
  - Fakes are never used on Vercel production (`VERCEL_ENV=production`), whatever the env says.
- **Paths:** each fake is mounted under its id and uses the real API's paths. With fakes on, `serviceBaseUrl("discord", "https://discord.com/api/v10")` is `http://127.0.0.1:3999/discord/api/v10`, and the fake's route is `/api/v10/...`.
- **The server:** `pnpm jack:fakes` (from `apps/platform`) runs every registered fake on one loopback port. `--port 4000` picks another.
  - `GET /` lists the mounted fakes and their routes; `GET /_health` answers `{ ok: true }`.
  - It logs one line per request (method, path, status, time). It never logs the query string, headers or bodies, and it masks any path segment that looks like a key. A client in fake mode still sends its real key, and some services put it in the query (`?access_token=`, `?key=`) or a webhook link's path.
- **Writing a fake:** it goes in `connectors/<service>/fake/handlers.ts` as a `FakeService` (`fakes/types.ts`).
  - `id` is the name `JACK_FAKES` uses and the mount path (lowercase letters, digits and dashes).
  - `create()` returns the routes, `{ method, path, handle(request, { params, path, baseUrl }) }`, with standard `Request` and `Response`. State lives inside `create()`, so every server start and every test mount begins fresh.
  - Use `:name` for path params and a final `*` for the rest of the path.
  - Throw `FakeNetworkError` to simulate a dropped connection.
  - Put test hooks (rename a file, go live, emit a webhook) under `/_fake/...`.
  - Reproduce what the research file's "How to fake it locally" lists: auth errors, paging, rate limits and error shapes.
- **Registering a fake:** add it to `connectors/fakes/slots/<track>.ts`. Only scripts and tests import the fakes registry; the app never does.
- **Tests:** `mountFakes()` (`fakes/testing.ts`) runs the same fakes in-process:

  ```ts
  afterEach(() => vi.unstubAllGlobals())

  it("reads the channels", async () => {
    const fakes = mountFakes([discordFake])        // or mountFakes() for every registered fake
    const client = discordClient(...)               // build the client after mounting
    ...
    expect(fakes.requests[0].headers.get("authorization")).toBe(...)
  })
  ```

  - It stubs `fetch` with `vi.stubGlobal`, and sets `JACK_FAKES` and `JACK_FAKES_URL` with `vi.stubEnv` (the Vitest config unstubs env after each test).
  - A fetch to any other origin rejects, so a test never reaches the network. So does a request whose signal is already aborted, as with the real `fetch`.
  - `fakes.requests` logs each call (method, service, path, headers, body). `fakes.restore()` puts the previous fetch back.
- **SDK notes for later tracks:**
  - **Anthropic** takes `baseURL`, so pass it `serviceBaseUrl()`.
  - **Stripe** takes only `host`, `port` and `protocol` (`research/stripe.md` §7). It drops any path, so `serviceBaseUrl()` can't reach a fake mounted at `/stripe`. Give it the fakes server's host and `serviceFetch("stripe")`, which adds the `/stripe` mount to each request. Use the fetch client always (it works on Vercel), since Stripe's default Node client doesn't go through `fetch` and `mountFakes` can't answer it:

    ```ts
    const fakes = fakesEnabledFor("stripe") ? new URL(fakesOrigin()) : null
    const stripe = new Stripe(key, {
      ...(fakes && { host: fakes.hostname, port: Number(fakes.port || 80), protocol: "http" as const }),
      httpClient: Stripe.createFetchHttpClient(serviceFetch("stripe")),
    })
    ```

    `fakes/testing.test.ts` runs exactly this against a fake `GET /v1/balance`.
  - **Resend** reads `RESEND_BASE_URL` once, when the module loads, so `JACK_FAKES` can't switch it (`research/resend.md`).
    - Locally, put `RESEND_BASE_URL=http://127.0.0.1:3999/resend` in `.env.local` next to `JACK_FAKES`.
    - In a test, set it before anything imports `resend`, and mount the fakes at the same origin: `vi.hoisted(() => { process.env.RESEND_BASE_URL = "http://127.0.0.1:3999/resend" })` at the top of the file, then `mountFakes([resendFake])`. Each test file loads its own copy of the SDK, but within a file the first value sticks. `vi.resetModules()` doesn't reload packages from `node_modules`, so stubbing the env later and importing again doesn't work.
  - Build SDK clients after mounting, because some capture `fetch` when they're constructed.

### The Connections page (`/admin/connections`, System)
- **Who sees what:** every officer can see the page (`requireOfficerPage()`). Only admins can switch a connection or run a smoke test; the server actions check the role and return "Only admins…" to officers.
- **Each registered connector's row shows:**
  - its state: Connected, Off, Not set up or Failing (the last error is newer than the last sync);
  - its env var names, each marked set or missing (names only, never values), and any missing settings;
  - the last sync, and the last error (redacted, with whether it has synced since);
  - the last smoke test and who ran it;
  - any extra details.
- **Planned connectors:** `ConnectorState` rows with no code yet are listed under "Not built yet".
- **The switch:**
  - Off always works, so a misbehaving connection can be stopped.
  - On needs the connector's code, its env and its settings.
  - Switching on without a passing smoke test asks first.
  - Both directions are audited (`ENABLE` and `DISABLE`).
- **Smoke tests:** "Run smoke test" calls `connector.smoke()` on the server; it works while switched off. The page's `maxDuration` is 60 s.
  - Each run is written to the audit log (actionType `SMOKE_TEST`, entityType `CONNECTOR`, metadata `{ ok, summary, ms }`). The page shows the latest one per connector.
  - A connector without one says "No smoke test yet".
- **Slots for later PRs:** `app/admin/connections/_panels/scheduler.tsx` (G3: the scheduler heartbeat) and `_panels/storage.tsx` (G5: file storage usage) are placeholders. Each PR replaces only its own file; the page renders both through `SafeSlot`.

### Env vars
| Name | Where | What |
|---|---|---|
| `JACK_FAKES` | `.env.local` only | `all`, or a comma list of service ids, to use the fakes. Ignored on Vercel production |
| `JACK_FAKES_URL` | `.env.local` only | The fakes server, default `http://127.0.0.1:3999`; http on this machine only |

### Trying it locally
1. Run the DB check: `pnpm --filter @lsr/platform exec tsx scripts/check-connectors.ts` (local database only).
   - It uses a throwaway connector id and deletes what it wrote.
   - It checks the switch and its audit entries, the cursor round trip (JSON in, the same JSON out, SQL NULL when cleared), redacted errors, statuses and the page's rows.
2. Start the fakes and call one: `pnpm jack:fakes`, then `curl http://127.0.0.1:3999/example/v1/ping`.
3. To see a registered connector on the page:
   1. Register `exampleConnector` (`connectors/example/client.ts`) in `connectors/slots/groundwork.ts` locally (don't commit it).
   2. Start the dev server with `JACK_FAKES=all EXAMPLE_TOKEN=example-fake-token`, and run `pnpm jack:fakes`.
   3. Open `/admin/connections` as an admin. Its smoke test passes against the fake ("Read 0 notes"), and the switch works.

## Scheduler (G3)

Scheduled work for 2.0 (design §6; research: `research/supabase-pg-cron.md`). pg_cron runs `scheduler.tick()` every minute; when a `ScheduledJob` row is due, it posts a signed request to the site, and the site runs the job.

### How it fits together
- **The tick** (SQL, migration `20261023020000_jack2_scheduler`): writes `SchedulerHeartbeat.lastTickAt` on every call, then posts to `lsr_scheduler_url` through pg_net only when an enabled job is due and unlocked. It signs `v1=hex(HMAC_SHA256(secret, ts + "." + body))` over the jsonb text it sends; the secret never travels (pg_net's queue is readable by every database role).
- **`POST /api/cron/tick`** (`src/app/api/cron/tick/route.ts`): reads the raw body, verifies it (`src/lib/scheduler-signature.ts`: ±300 s, current or previous secret, constant time, fails closed with no secret), records `lastDispatchAt`, answers `202 { ok, due }` (counts only: pg_net keeps response bodies 6 hours where any role can read them), then dispatches in `after()`. 401 for anything unsigned or stale, 405 for a GET (what a redirect would turn pg_net's POST into).
- **The dispatcher** (`src/server/scheduler/dispatcher.ts`):
  - claims each due job with a conditional update (enabled, due, no live lock), setting `lockedUntil` = claim + 360 s and `nextRunAt` = the next run after now in America/Chicago (`schedule.ts`, cron-parser), so missed runs don't pile up. The claim, failing orphaned runs and opening the new run row are one transaction, so a claim that fails part way leaves the job due and unlocked;
  - runs at most 3 jobs at once, stops claiming 200 s into the request, and only claims an inline job whose `budgetMs` fits before 290 s;
  - skips kinds this code doesn't know: never claims or fails them, but moves their next run on, so an enabled job of a removed kind doesn't make the tick call the site every minute;
  - marks a run still `running` from a dead function as failed when its job is next claimed;
  - records each run in `ScheduledJobRun`; errors and summaries go through `redactSecrets()`. A job that ignores its abort signal is recorded as failed 5 s past its deadline and keeps its lock until the lock runs out, so no other tick starts it meanwhile.
- **Hand-offs:** a kind with `handoff: true` is claimed, then posted to `POST /api/admin/jack/run` with `{ jobId, runId, lockedUntil }`, signed over `"run." + ts + "." + body` so a tick's signature can't be replayed there. The route swaps the lock using the exact `lockedUntil` as a one-time token (a replay gets 409), answers 202 and runs the job in `after()` with its own 300 s. It sits under `/api/admin/jack/**`, so the Chromium binary is traced into it. Hand-offs go to the canonical site in production and to the tick request's own origin elsewhere.
- **Housekeeping** (`jobs/groundwork.ts`, all daily around 4 AM CT, all off until an admin turns them on): `housekeeping.job-runs` (runs older than 90 days), `housekeeping.cron-history` (`cron.job_run_details` older than 7 days, skipped where there's no pg_cron), `housekeeping.twitch-samples` (`TwitchViewerSample` older than 180 days).
- **Checks** (`automation/checks/groundwork.ts`): "Scheduler not ticking" (jobs are on but no tick for 10 minutes) and "Failing scheduled jobs" (names and links only, never error text).

### Adding a job kind (for the tracks)
Add a `JobKind` to your `src/server/scheduler/jobs/<track>.ts`:
- `kind` (stable, saved on the row: `discord.sync`), `label`, `description`, `defaultSchedule` (five-field cron, Central time), `budgetMs`.
- Inline jobs keep `budgetMs` at 2 minutes or less; anything longer (Jack runs, backfills) sets `handoff: true` (up to 290 s). `registered-kinds.test.ts` checks every kind.
- `run(ctx)` gets `signal` (aborted at the deadline: stop and return what's done), `deadline`, `startedAt` (pass it to `runRoom` as `startedAt`), `log(line)`, the row's `config` and `job: { id, key }`. Return `{ summary, counts?, status? }`; return `status: "skipped"` when your connector is off or not configured; throw on failure. Never log secrets or personal data.
- Jobs may run again after a crash or a lock timeout, so make them idempotent.
- A kind with one job gets its row from `ensureJobRows()` (the Scheduled jobs page and the setup script call it), keyed by the kind and switched off. Kinds whose feature creates one job per row (recurring questions: `recurring:<id>`) set `singleton: false` and create their own `ScheduledJob` rows; their schedules aren't editable on the Jobs page.
- Try it locally with `pnpm --filter @lsr/platform jack:tick --job <key>` (runs it now even while switched off).

### Env
- `SCHEDULER_SIGNING_SECRET`: 32+ random bytes, hex. The same value goes in Vault as `lsr_scheduler_secret`. Separate from `CRON_SECRET`. Without it every tick and hand-off is refused.
- `SCHEDULER_SIGNING_SECRET_PREVIOUS`: only while rotating.

### Setup (production, Gray)
1. Enable pg_cron and pg_net in the Supabase dashboard; the 2.0 migrations are applied.
2. Make a secret (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), set it in Vercel as `SCHEDULER_SIGNING_SECRET` (Production, Sensitive) and redeploy.
3. `pnpm --filter @lsr/platform jack:scheduler-setup` prints the SQL: Vault values (`lsr_scheduler_secret`, `lsr_scheduler_url` = `https://www.longhornsimracing.org/api/cron/tick`, exact, no redirects), `cron.schedule('lsr-scheduler-tick', '* * * * *', 'select scheduler.tick()')`, a daily `cron.job_run_details` cleanup, and checks. Replace the secret placeholder and run it in the SQL editor. It never prints the production secret. It also creates the job rows in the database `DATABASE_URL` points at (`--no-db` skips that).
4. Check `/admin/jobs`: the Scheduler panel says "Ticking" within a minute. Then turn jobs on.

**Rotating the secret:** in Vercel set `SCHEDULER_SIGNING_SECRET_PREVIOUS` to the old value and `SCHEDULER_SIGNING_SECRET` to the new one, redeploy, update Vault with the setup SQL, then remove `_PREVIOUS`.

**When something's wrong:** the Scheduler panel shows the last tick, whether pg_cron's tick job is scheduled and active (and its last run), and how the site answered pg_net in the last 6 hours: 401 = the Vault secret and `SCHEDULER_SIGNING_SECRET` differ; 3xx or 405 = the URL redirects; 404 = the route isn't deployed. Pause with `cron.alter_job(..., active := false)` (in the printed SQL).

### Locally
- There's no pg_cron schedule on the shared local database. `pnpm --filter @lsr/platform jack:tick` runs the due jobs once, in-process (hand-off jobs too, whatever their budget, with the deadline capped at 290 s from the start); `--job <key>` runs one job now; `--http [url]` sends a signed tick like pg_cron's to a running dev server (default `http://localhost:3000/api/cron/tick`; needs `SCHEDULER_SIGNING_SECRET` in `.env.local`, the same in both). All refuse non-local targets.
- Prefer `--job` to switching jobs on: a switched-on job runs from every worktree that ticks the shared database.
- `pnpm --filter @lsr/platform exec tsx scripts/check-scheduler.ts` checks the database side (SQL and Node signatures agree, claim races, the hand-off token, orphans, `ensureJobRows`, the prune SQL), writing only rows it deletes again.
- `jack:scheduler-setup --local [--port 3113]` prints the same SQL for the local stack (`http://host.docker.internal:<port>`), only if you really want pg_cron calling a dev server; undo it with the printed "Remove" line.

### Choices made here
- The lock is claim + 360 s (the design's "300 s + margin"), longer than any function lives, so a lock that ran out means its run is gone.
- Run now needs the job switched on (it moves `nextRunAt` to now; the next tick runs it). Turning a job on sets its next run from now, so a job that's been off doesn't run straight away.
- Officers see the Jobs page read-only; switching, Run now and schedule changes are admin-only and audited (`SCHEDULED_JOB`).
- If the dispatcher's hand-off POST gets no answer, it cancels the hand-off only while the lock is still its own; if the route already took it over, the route records the run.
- `JobKind` gained `singleton?: false` and `JobContext` gained `startedAt`.

Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Proposals (G4)

Jack proposes; an officer applies (design §4). Code paths are relative to `apps/platform/`.

### How it works

1. **Propose.** Jack calls a `propose_*` tool with `{ proposal: { kind, ...fields } }`. `createProposal` (`src/server/jack/proposals/service.ts`) validates the fields with the kind's schema, has the kind describe the change (`prepare`: title, summary, diff rows, people, links, rows; no writes), and saves a PENDING `JackProposal` that expires in 14 days. A newer proposal for the same kind and target in the same room marks the older pending ones SUPERSEDED (with a note). The reply shows a small `proposal` display: the title, summary and first few changed fields.
2. **Card.** `src/components/jack/parts/proposal-card.tsx` loads the whole proposal from `GET /api/admin/jack/proposals/[id]` (officers only): the saved view, with long text as a line diff (`src/lib/jack/line-diff.ts`, no library), names, and whether the viewer may apply it. It follows the live status from the room (the snapshot's `proposals` map and `proposal.updated` events); the reply's saved tool calls never change. Pending: **Apply** (asks first for kinds marked `destructive`) and **Discard**; a proposal with rows gets a checkbox per row (matched rows start checked). The route sends exactly the rows Apply checks picks against. After: who applied or discarded it and what came of it. Outside links show their host (`PartLink`).
3. **Apply** (`applyJackProposal`, any officer; `applyProposal` in the service):
   - the proposal's permission (the kind's `permission`, or stricter from its `permissionFor` for this payload) is checked against the **applying** officer's roles, read from the database, before the claim; picked rows are checked against the proposal's rows;
   - the claim is one conditional update: `status PENDING → APPLYING, claimedAt = now WHERE id AND status = 'PENDING' AND expiresAt > now`, so of several officers clicking at once exactly one gets it;
   - then, outside any transaction: re-validate the payload, check the file's sha256 (kinds built from a file), `checkStale`, `apply`;
   - it ends **APPLIED** (result: summary, links, created ids, applied rows), **STALE** (the reason) or **FAILED** (the error, through `redactSecrets`). APPLIED and FAILED get an audit entry (`entityType: JACK_PROPOSAL`, `actionType: APPLY | APPLY_FAILED`, the applying officer as actor, `metadata { via: "jack", proposalId, roomId, proposedFor, kind }`).
4. **Discard** (`discardJackProposal`, any officer, any kind): DISCARDED, audited (`DISCARD`).
5. **Expiry is lazy:** a PENDING proposal past `expiresAt` reads as STALE everywhere (snapshot, route, Proposals page) and is written STALE, with a note, when someone applies or discards it, or by the sweep job. Opening a card only reads, so an old room doesn't fill up with late notes.
6. **Room notes for every final status**, as system messages, so Jack's history carries outcomes ("(Room note: Dylan applied: Edit the page “LSC Rules” → /admin/pages/…)"):
   - `Dylan applied: <title> → <first site link of the result>`
   - `Couldn't apply: <title>. <error>`
   - `Stale: <title>. <reason>` (also for expired: "Nobody applied it within 14 days.")
   - `Discarded by Gray: <title>`
   - `Superseded: <title>. Jack proposed a newer version.`
   The room links a note's trailing site path (`noteWithLink` / `noteLink` in `src/lib/jack/proposals.ts`, `NoteText` in the room).

### The pieces

| Piece | Where |
|---|---|
| Service: create, apply, discard, detail, room states, sweep | `src/server/jack/proposals/service.ts` |
| Errors kinds throw (`ProposalInputError`, `StaleProposalError`) | `src/server/jack/proposals/errors.ts` |
| Exact find-and-replace (all or none), for text kinds | `src/server/jack/proposals/text-edits.ts` |
| `page.update`, the reference kind | `src/server/jack/proposals/page-update.ts`, registered in `kinds/groundwork.ts` |
| Page service (the admin form and `page.update` both save through it) | `src/server/services/page.service.ts` |
| The `propose_*` tools | `src/server/jack/tools/propose.ts`, sent from `tools/registry/groundwork.ts` |
| Officer route | `src/app/api/admin/jack/proposals/[id]/route.ts` |
| Apply and Discard actions | `src/app/admin/jack/proposals/actions.ts` |
| Proposals page (Jack → Proposals) | `src/app/admin/jack/proposals/page.tsx`, list query in `src/server/jack/proposals/list.ts` |
| Card, its room context, note links | `src/components/jack/parts/proposal-card.tsx`, `proposal-context.tsx`, `src/components/jack/note-text.tsx` |
| Sweep job `proposals.sweep` | `src/server/scheduler/jobs/proposals.ts` (joined into the groundwork slot) |

### Adding a kind (for the other tracks)

1. Write the kind (`ProposalKind<P>`, `src/server/jack/proposals/types.ts`) in your track's code and add it to `src/server/jack/proposals/kinds/<track>.ts`. Set `tool` to one of the `propose_*` tools: **that tool appears as soon as one kind names it**, with your kind's `description` in its list. A tool with no kinds isn't sent. The rarer tools (`propose_discord`, `propose_deck_publish`, `propose_meeting`, `propose_recurring`) are marked `deferred` for tool search (G8).
2. **`schema` must be a `z.object`** (refinements are fine) without a field named `kind`: the tool adds `kind` and shows the model every field (with `.describe()` text). Loading the registry throws otherwise.
3. **`description`** starts with the kind's key ("page.update: …") and says what it changes and how to get the ids and text it needs. "Only an admin can apply it." is added for `permission: "admin"`; a kind with `permissionFor` says itself which payloads need an admin.
4. **`prepare(p, ctx)`** only reads. Throw `ProposalInputError` for anything the model can fix (no such record, a find that isn't there, nothing would change): the message goes back to it as the tool's error and nothing is saved. Return:
   - `before`: a snapshot of what it changes, as it is now (JSON);
   - `targetId` (with the kind's `targetType`) when it changes one record: a newer proposal for the same target supersedes the older one;
   - `view`: title and summary written by the server (the model never writes them), `diff` rows (`format: "markdown"` for long text gets a line diff on the card), `people`, `links` (site paths or outside URLs), and `rows` when officers pick which rows to apply (see 6);
   - `fileSha256` for kinds built from a room file. **The payload must then name the file as `fileId`**: Apply compares that `JackFile`'s sha256 and status (READY) and goes STALE if it changed.
5. **`checkStale(p, before)`** returns why it's stale (shown to officers and Jack) or null.
6. **`apply(p, ctx)`** makes the change through the same service the admin page uses, and returns `{ summary, links?, created?, appliedRows?, counts? }`; the first site link becomes the note's link. `ctx` carries:
   - `officer`: who pressed Apply (the audit actor);
   - `before`: the snapshot `checkStale` just passed. Make the write conditional on it where you can (the page service's `expected`), and throw `StaleProposalError` when that write misses, so the proposal goes STALE instead of FAILED;
   - `auditMetadata`: pass it to the service's own audit entry for the change, so the change links back to the proposal;
   - `idempotencyKey` (`proposal:<id>`) for outside services;
   - `selectedRows`: the row ids the officer left checked, for a proposal with rows; undefined means every row. The framework records them as `appliedRows` unless the kind does. A proposal's rows are the `view.rows` `prepare` saved, or else `list.rows(payload)`. **Rows built on the server** (an import's file rows, a notification's audience, names matched to members) go in `view.rows` alone, with no `list`: they're saved with the proposal and picks are checked against them. `list.rows` is only for rows the payload alone rebuilds.
   Anything else thrown marks it FAILED with the message (redacted). Revalidation lives in the service the kind calls, as it does for the admin page.
7. Set `destructive: true` when applying can't be taken back (sends, posts, deletes): the card asks first.
8. **`permissionFor(p)`** (optional), when some payloads need more than the kind's `permission`: an `import.rows` proposal into an admin-only target returns that target's `permission`. It's checked before the claim and decides the card's Apply button, so an officer who can't apply it never burns it to FAILED. It can only make the permission stricter; one that throws means admin.
9. Test it like `page-update.test.ts` (mocked Prisma and service). The framework's own behavior (claims, notes, expiry) is covered once, in `service.test.ts`.

### Database change (additive)

**One new nullable column, `JackProposal.view` (JSONB)**, in `prisma/migrations/20261023041400_jack2_proposal_view`. It saves the card a kind built when proposing; the card can't be rebuilt later because the records it describes may have changed. Applied locally with `prisma migrate deploy`; `migrate diff --exit-code` against a throwaway shadow database reports no difference. JackProposal's RLS policy and `jack_readonly`'s table grant cover it.

### Env vars and setup

None new. The sweep job (`proposals.sweep`, every 10 minutes, Central) is registered for the scheduler (G3); like every job it starts switched off until an officer turns it on, and the release plan (design §17, step 5) turns it on first. Without it, an apply that died partway stays APPLYING (its card keeps spinning), and an expired proposal reads as stale but gets its "Stale" note only when someone acts on it.

### Try it locally

- `pnpm --filter @lsr/platform exec tsx scripts/try-jack-proposal.ts` puts a `page.update` card in a new room "Proposal check" (default page: the LSC rules; `--page=<slug>`, `--room=<id>`, `--as=<email|handle>`). A scripted fake Claude answers through the real reply loop and calls `propose_change`, so nothing is spent. Open the printed room, then Apply or Discard; Admin → Pages shows the edit, Jack → Proposals the outcome. Without `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the env it can't broadcast; reload the room.
- `pnpm --filter @lsr/platform exec tsx scripts/check-jack-proposals.ts` checks the framework against the local Postgres: five Applies at once (exactly one wins), superseding, staleness, lazy expiry, discard and the notes. It uses a test kind (no club data), and deletes its room, proposals, notes and audit entries.
- Unit tests: `src/server/jack/proposals/*.test.ts`, `src/server/jack/tools/propose.test.ts`, `src/server/services/page.service.test.ts`, `src/lib/jack/line-diff.test.ts`, `src/lib/jack/proposals.test.ts`, `src/server/scheduler/jobs/proposals.test.ts`, the route and action tests.
