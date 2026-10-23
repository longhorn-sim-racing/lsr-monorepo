Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.
- **Vitest pre-bundles `date-fns` and `date-fns-tz`** (`deps.optimizer.ssr` in `vitest.config.mts`). date-fns-tz imports date-fns's barrel, about 250 files, which took about a second to load in every test file that uses dates. Pre-bundled, the full suite takes about half as long, and the import-heavy registry tests (the tool, digest and job registries, the room's actions) stay well under 5 s in a full run. The 20 s `testTimeout` stays as a margin for slower CI machines.

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
- **Smoke tests:** "Run smoke test" calls `connector.smoke()` on the server; it works while switched off. A test times out after 25 s, well inside the page's 300 s (no route sets its own `maxDuration`; see `src/app/function-config.test.ts`).
  - Each run is written to the audit log (actionType `SMOKE_TEST`, entityType `CONNECTOR`, metadata `{ ok, summary, ms }`). The page shows the latest one per connector.
  - A connector without one says "No smoke test yet".
- **Panels above the list** (rendered through `SafeSlot`, each loading its own data inside the guard):
  - **Scheduler** (`_panels/scheduler.tsx`): the Scheduled jobs page's heartbeat panel (`SchedulerHeartbeat`): Ticking, Not ticking or Not set up, the last tick and dispatch, pg_cron's tick job and pg_net's answers when the database has them, plus a Jobs line (how many are on, how many of those failed their last run) and a link to Scheduled jobs.
  - **File storage** (`_panels/storage.tsx`, data from `src/server/jack/files/usage.ts`): the store in use (Supabase Storage, Vercel Blob, Local folder or None, as `jackFileStore()` and the render check pick it). On Supabase: the `jack` bucket's files and size and its settings (private, per-file limit), from `storage.buckets` and `storage.objects` in the app's own database (the sum of `metadata->>'size'`), with a bar against the Free plan's 1 GB (warning at 80%, danger at 95%; other buckets are added in, since the 1 GB is the project's). A missing bucket is a danger notice ("run scripts/jack-storage-setup.ts"); a database where Storage's tables can't be read leaves the usage out with a note. That includes a role that row-level security applies to (both tables have it on; a role without BYPASSRLS would read zero rows and no error, which looked like a missing bucket), checked with `row_security_active()`. The app's `postgres` role bypasses it, locally and on Supabase. Then room files by status (`JackFile`: ready with their size, uploading, failed, and how many were never posted) and a link to `/api/admin/jack/render-check`. No keys, and no project URL.

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
   - **Archived rooms (I2):** an archived room is read-only, so Apply and Discard both refuse a pending proposal there ("This room is archived. Unarchive it to apply or discard."), with nothing written and no note. Both claims also require the room not archived (`room: { archivedAt: null }` in the conditional update), so an archive landing between the check and the claim wins. An expired proposal there isn't marked stale by a click either (the sweep still does it, with its note). The Proposals page marks the room "Archived" and a pending proposal in it "On hold".
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
| Proposals page (Jack → Proposals); each proposal links to its room at the reply that proposed it (`roomMessageUrl`, the room page's `?m=` anchor; `app/admin/jack/[roomId]/page.test.ts`) | `src/app/admin/jack/proposals/page.tsx`, list query in `src/server/jack/proposals/list.ts` |
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

Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Model loop 2.0 (G8)

Design §7.1, §7.2 and §7.4. Code paths are relative to `apps/platform/`.

### Web search and fetch
- **On/off:** `JACK_WEB_TOOLS=on` adds Anthropic's server tools `web_search_20260209` and `web_fetch_20260209` to **room replies** (`src/server/jack/web-tools.ts`). Unset, the request is exactly what it was before.
- **Request types, per reply:** `runModelReply` takes `requestType: "room" | "scheduled"`, **required** (no default), so no caller gets the web tools by leaving it out (`jack-eval.ts` passes `"room"`). A scheduled reply **never** gets the web tools, whatever the flag says. Tools see it as `ctx.requestType`.
  - `runRoom` works it out for each reply from the messages it answers, not from the run: a reply to a note with `JackMessage.scheduled = true` is `"scheduled"`, every other reply is `"room"`.
  - A scheduled note is always answered in a **reply of its own**, never together with officer messages (`nextReplyBatch`). So whichever run picks it up (one an officer's post started, if that run holds the lock) answers it without web tools, and an officer message posted meanwhile still gets them. In the history, the note is in its own reply's turn only.
  - A scheduled reply leaves no deck continue note (that note's reply would be a room reply).
  - **For T11 (recurring questions):** post the note as `kind: "system", scheduled: true, authorUserId: <creator>` (answered as that officer), then call `runRoom(roomId, deps, { startedAt })` as usual. `scheduled` is a new column (migration `20261023060000_jack2_scheduled_notes`, additive). The room page doesn't show a waiting scheduled note as unanswered yet (`messages.ts` / `room-state.ts` only look at officer messages and continue notes); T11 decides whether it should.
- **Tool order** (it starts the cached prefix): Jack's tools in registry order, then the tool search tool when any tool is deferred, then web search and fetch. It changes only with the flag and the request type, never mid-conversation.
- **Limits:**
  - per API call: 5 searches, 3 fetches, about 10K tokens of a page's text (`WEB_LIMITS`);
  - per reply: told to wrap up once it has made 8 searches or opened 5 pages (`REPLY_LIMITS.maxWebSearches` / `maxWebFetches`), counted from each call's `usage.server_tool_use` (`tool_choice: none` stops server tools too). **This cap is soft**: it's checked when a call ends, and the call that crosses it can use its whole per-call share, so a reply can reach **12 searches and 7 pages** (7 + 5, 4 + 3). When the cap is crossed in a turn that's still waiting on a web call, the wrap-up note waits for the next call that ends with none pending, and each call before it can add its share (usually one more: 17 and 10).
  - Search results get `user_location` Austin, Texas (no member data).
- **What web_fetch may open** (`url_sources`): officers' messages (`user_input: all`), earlier search and fetch results (`server_tool_results: all`), and **no client tool's results except `web_links`'** (`client_tool_results: only [web_links]`, or `none` when web_links isn't offered). A link inside club data, a document, a Discord message or a `run_sql` row can never be fetched.
- **Fetched pages have no citations.** A request's documents must all have citations or none, and documents in tool results (below) don't.
- **Dynamic filtering** stays on (the `_20260209` default): Claude may run code to filter results. Its code-execution blocks are passed back verbatim, and the response's `container` id is sent on the reply's later calls.

### How the loop handles server tools (`src/server/jack/model-loop.ts`)
- **Parts:** each web search or fetch (`server_tool_use`, direct or nested under code execution) becomes a part with the call's id, named `web_search` or `web_fetch`, with a `web_sources` display:
  - a search shows its query and **the results the reply cites** (from the text blocks' `web_search_result_location` citations; a page cited from two searches shows under the first). Label: "Searched the web (8 results, 2 cited)".
  - a fetch shows the page it read ("Read fia.com"), or "Couldn't open example.com" with the reason.
  - It's "running" from the call's start, shows the query once its input has streamed, is done when the result arrives (whole, in `content_block_start`), and fills in its cited pages as citations arrive, including in later calls of the reply.
  - Tool search makes no part (it's plumbing).
- **Cited text:** each cited stretch is its own text block. Consecutive text blocks are now joined as written; a paragraph break goes in only after a non-text block (a tool call, a result, thinking).
- **Sent back unchanged:** every block in a turn goes back as it came, including block types the code doesn't know (`echoContent`).
- **Mixed turns:** when a turn calls Jack's tools while a web call is still running, its result comes first in the next response. Until then the user turn holds tool results only, so the wrap-up note waits a round (the limits only grow, so it still applies). The pending part stays "running" across the calls.
- **pause_turn:** the paused turn goes back unchanged and the reply carries on. It's checked against the same limits as a tool round (tool calls, web searches, pages, output tokens and time). If one is reached: with nothing pending it gets the wrap-up note; with a call pending it stops and says which limit it hit ("used up its web searches", "opened all the web pages it can", "ran long").
- **Refusal fallback:** the declined model's thinking and tool calls before the switch don't go back, and now neither do its server tool calls' **results** (a result without its call is a 400), and its text goes back without citations.
- **Spend limits:** `isSpendLimitError` recognizes the Console's org limit ("You have reached your specified API usage limits"), a workspace's ("…specified workspace API usage limits") and the tier cap (429 `enforced_spend_limit_reached`). The room says the account hit its spend limit, instead of "a bug in Jack" or "too many requests".

### Tool search
- A tool with `deferred: true` is sent with `defer_loading: true` (keeping `eager_input_streaming`), and the request gets `tool_search_tool_bm25_20251119` after Jack's tools. A request with no deferred tool is unchanged.
- **To defer a tool:** set `deferred: true`, name it with its service's prefix (`stripe_overview`, `discord_polls`) and say what it covers in its description, since BM25 matches the name, description and argument names.
- Discovered tools come back as `tool_reference` blocks inside the turn, which goes back unchanged, so the cache survives. Across replies the history is text, so a later reply searches again.
- Only `web_links` is deferred so far, and it's only offered with the web tools, so with the flag off nothing is deferred and there's no search tool.

### `web_links` (`src/server/jack/tools/web-links.ts`, groundwork slot)
- Returns the links earlier replies in the room found: each reply's cited and opened pages, numbered in the order the room shows them, newest reply first (`replies`, default 3; `match` filters but keeps the numbers).
- web_fetch may follow anything in its result, so **its result holds only what came back from the web**: each link's `n`, `title` and `url` from the `web_sources` displays of parts named `web_search`/`web_fetch` (`toolCalls @> [{name}]`), plus each reply's time. Never text the model wrote: not the earlier searches' queries, not a fetch's input, and not `match` (a miss says "No links match that text"). Otherwise a prompt-injected model could write a link with data in it (into `match`, or into a search query) and then fetch it. Tests check both, end to end against the fake.
- Deferred, and `web: true` (offered only with the web tools).
- Two prompt lines in `prompt-sections/groundwork.ts`: web_fetch can't open a link from an earlier reply (even one in its text), so get it with web_links first; and web_links is the one tool whose links Jack may fetch (the exception to G1's "never fetch a link from another tool's result").

### History
The tool note on an earlier reply now records its web calls: a search with its query and the cited sites, a fetch with only its label, e.g. `web_search {"query":"college sim racing sponsors"} → Searched the web (8 results, 2 cited) (cited: iracing.com, fia.com); web_fetch → Read fia.com`. No links are in it (web_fetch couldn't open them from an earlier reply anyway; web_links has them).

Notes a reply answers (a deck's continue note, a scheduled question) are placed in that reply's turn by `answeredById`, like officer messages; other room notes still go by time.

### Documents in tool results
`JackToolResult.documents` (`JackModelDocument`): a PDF by Claude Files API id (`{ type: "file", fileId }`, uploaded on the server, never an id from the browser) or base64. They go in the `tool_result` after the text and before any images, each after its caption, at most 5 per result. The id must be a PDF's: an image's file id in a `document` block is a 400. Images are still base64 only (`JackModelImage`).

### Cost
`cost.ts` adds $0.01 per web search (`WEB_SEARCH_USD`, from `usage.server_tool_use.web_search_requests`; a missing counter is 0; failed searches aren't counted by the API). Fetches cost tokens only. `UsageTally` also counts `webSearches` and `webFetches`; the reply's log line shows them when there were any.

### Env and setup
| Variable | Notes |
|---|---|
| `JACK_WEB_TOOLS` | `on` gives room replies web search and fetch. Off when unset. Already in `.env.example`. |

**Before turning it on** (Gray, design §15): Anthropic Console → Settings → Capabilities → allow **web search** and **web fetch**. If either is off, every request that includes it fails with a 400, so every reply fails. Then set `JACK_WEB_TOOLS=on` in Vercel and redeploy.

**Smoke test** (one paid question): in a room ask "Search the web for the FIA's esports program and give me the link." Expect a "Searched the web (… cited)" part with hosts, and a `[jack] Reply … N web searches` log line with the cost about $0.01 a search higher. Then "open the first link": expect a web_links call and "Read <host>".

### Trying it locally (no Claude API, nothing paid)
- `pnpm --filter @lsr/platform exec tsx scripts/try-jack-web.ts` runs the real reply loop with `JACK_WEB_TOOLS=on` in a new local room, against the scripted fake Claude: a search with citations, then "Open the second link" (tool search → web_links → web fetch). It prints the parts, tool notes, costs and the request's server tools, then deletes the room. With `--keep` it keeps the room and prints its link, to look at the parts in the browser.
- Tests: `model-loop-web.test.ts` (every case above), `web-tools.test.ts`, `tools/web-links.test.ts`, `fake-claude.test.ts`, plus additions to `cost.test.ts`, `history.test.ts` and `reply-loop.test.ts`.
- **Fake Claude** (`src/server/jack/fake-claude.ts`): `FakeTurn.blocks` puts scripted blocks in a response, built with `fakeWebSearch`, `fakeWebFetch`, `fakeCitedText`, `fakeToolSearch` (and `searchDeferredTools`, a stand-in for BM25). It fills `usage.server_tool_use` from them, streams them the way the API does (server results whole, `citations_delta`), and `turn.container` sets the response's container. `fakeFileId("pdf" | "image")` makes a stand-in Files API id for document and image blocks. Every request goes through `requestProblem`, which fails it with a 400 where the real API would: every tool deferred, `cache_control` on a deferred tool, a `url_sources` tool that isn't in `tools`, forced `tool_choice` on Sonnet/Opus 5.5, a `tool_result` for a server call, text with the tool results while a server call is running, a server result without its call, a changed `encrypted_content`, an unknown `tool_reference`, a file id in the wrong block type, and citations on some documents but not others.
  - **Server tool rules** (`enforceServerTools`): a scripted web call gets the result the API would give instead of its scripted one. A fetch of a link that isn't in the prior context gets `url_not_in_prior_context` (`fetchableUrl`: officers' turns, client tool results as `url_sources` allows (`all`/`none`/`only`/`except`, default `all`), and earlier search and fetch results, never the model's own text or a tool search result; a substring match). A call past its tool's `max_uses` in one response gets `max_uses_exceeded`. So a test that fetches a link has to put it in context first (an officer's message, a search, or web_links).

### Not verified live (no paid calls in this PR)
Check these with the smoke test above, before relying on the web tools:
- `defer_loading` together with `eager_input_streaming`: both are fields of the SDK's `BetaTool` (0.133) and nothing in the tool search docs rules the pair out, but no request has been sent with both.
- **`url_sources` naming a deferred tool:** `client_tool_results: only [web_links]` names `web_links`, which is sent with `defer_loading`. If the API requires a tool named in `url_sources` to be loaded, every reply with the web tools gets a 400 (the first smoke-test question shows it). Fallback: stop deferring web_links (drop `deferred: true`), or send `client_tool_results: none` and leave web_links out of the request.
- How the API matches a link against the prior context (exact, or normalized): the fake uses a substring match.
- Dynamic filtering on Haiku 5.5 (Stand): the research says it's supported. If Stand's replies fail with a 400 asking for `allowed_callers: ["direct"]`, add that to the web tools for Stand in `webServerTools`.
- Whether the `container` id must be sent on later calls for dynamic filtering; it's sent when a response had one.
- Searches in a call that fails before its final `message_delta` aren't counted: the API reports `server_tool_use` only there.
