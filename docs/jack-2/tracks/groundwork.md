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
- `base-url.ts`: `serviceBaseUrl()` and the `JACK_FAKES` switch.
- `fakes/`: the fake framework (below).
- `example/`: the template service (a fake, a client, a connector and its test). It's never registered as a connector, so it doesn't show on the page.

### Adding a connector
1. **Use the seeded id.** G1 seeded a `ConnectorState` row, switched off, for each planned connector: `discord`, `twitch`, `stripe`, `resend`, `site-traffic`, `instagram-insights`, `instagram-publish`, `google-drive`, `sharepoint`, `teams`. A new id gets its row (still off) on its first write.
2. **Write the client** with plain `fetch` (or the SDK) against `serviceBaseUrl("<service>", "<real base URL>")`.
   - Put a timeout on every call.
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
  - It logs one line per request (method, path, status, time), never headers or bodies.
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
  - A fetch to any other origin rejects, so a test never reaches the network.
  - `fakes.requests` logs each call (method, service, path, headers, body). `fakes.restore()` puts the previous fetch back.
- **SDK notes for later tracks:**
  - The Anthropic SDK takes `baseURL`.
  - Resend reads `RESEND_BASE_URL` when it's imported (`research/resend.md`).
  - Stripe needs `host`, `port` and `protocol` (`research/stripe.md` §7). Under `mountFakes` it also needs `httpClient: Stripe.createFetchHttpClient()`, since its default Node client doesn't use `fetch`.
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
