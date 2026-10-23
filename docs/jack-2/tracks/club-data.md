# Club data (T1)

Docs and env notes for the club-data track; folded into `docs/jack.md` at the end. Design: §7.1 (`search`, `read`, `recruiting_pipeline`, `race_performance`), §7.3 (paging), §3.2 (recruiting privacy), §10 (message anchors), §13 (the recruiting panel, results and profile additions, rooms search). Paths are under `apps/platform/`.

## What it adds

**Search** (`src/server/jack/search/`): one search over every full-text index, and one reader for whatever it finds.
- A **source** (`types.ts`, `SearchSource`) searches one kind of thing and returns hits in one shape: `{ source, type, id, title, url, snippet, date, meta, rank }`. `type` and `id` are what `read` takes. Sources come from slot files (`slots/<track>.ts`), joined in `registry.ts`; loading throws on a duplicate source key or read type.
- `search()` (`search.ts`) asks each named source (or every default one) for up to `limit` hits at once and merges them by rank (`ts_rank_cd` with normalization 32, so 0 to 1), newest first on a tie. A source that's switched off reports why (`notSearched`); one that fails is logged and reported without failing the rest.
- Queries go through `websearch_to_tsquery('english', …)`: words, `"a phrase"`, `or`, `-word`. Snippets come from `ts_headline` (two short fragments, plain text, at most 320 characters).
- The sources:

| Key | What | Index | Rules |
|---|---|---|---|
| `knowledge` | Knowledge entries | `JackSearchDoc` (`knowledge`) | Archived entries left out. `meta.ageDays` (from reviewed, else source, else updated date) and `meta.notReviewed` (saved by Jack, nobody reviewed it). `read` gives `meta.versionId`, the current version (newest by time, then id, as the knowledge service picks it), for the memory track's updates. Hits link to the entry's page, `/admin/knowledge/<id>` |
| `documents` | Drive and SharePoint documents | `JackSearchDoc` (`document`) | Deleted documents left out; `read` says when a file's text is gone or wasn't read (`textStatus`) |
| `rooms` | Messages in Jack rooms | `JackSearchDoc` (`room_message`) | Officers' messages and room notes. Jack's own answers only with `includeJackReplies`, every one labelled "Jack's earlier answer (not a source)". The question a reply is answering is never one of its results. `read` returns the message with 6 messages on each side |
| `site` | The public site | `to_tsvector` on the fly (small tables) | Published public posts; content pages the site shows (`PAGE_PUBLIC_PATHS`); public events (never their meeting or stream links); gallery albums with photos (as `/gallery` lists them); Instagram posts that aren't hidden |
| `teams` | Teams channel messages | `JackSearchDoc` (`teams`) | Only while the `teams` connector is switched on (`ConnectorState`, no row = off), for search and for `read`. Deleted messages left out; `read` returns the thread's first message and up to 29 replies around the opened one (always including it), saying how many replies it left out on each side |

A source that's switched off (Teams, until it's connected) is skipped quietly in a default search; the result and the room's links card say so only when the call named it in `sources`. A source that fails is always reported.

- **Discord** is the discord-read track's: it fills `search/slots/discord-read.ts` with a live source (design §12.1). A source's readers come with it, so `read` takes its types too.

**Tools** (`src/server/jack/tools/`, registered in `tools/registry/club-data.ts` in this order):
- `search` (always loaded): the search above. Input `{ query, sources?, includeJackReplies, limit }`; the room shows the hits as links (outside links with their host).
- `read` (always loaded): opens one thing by `{ type, id }`. Long texts come a page at a time (`offset`, `maxChars` up to 18,000, default 15,000): the result has `total`, `nextOffset` (null at the end), and an outline of its `#` headings when it's longer than a page. With `query` it returns only the paragraphs that match, best first until `maxChars`, back in document order (`search/paging.ts`). Either way the page is shortened when needed so the whole result (outline and JSON escaping included) stays under `MAX_MODEL_CHARS` (20,000; `fitToCap`), and `nextOffset` is where the text sent actually stops.
  - `site_page`: any public page of the site by its path (`search/site-page.ts`). The path must match `^\/(?![/\\])`, with no spaces, control characters, backslashes or encoded slashes and dots, and not be under `/admin`, `/api`, `/account`, `/auth` or `/_next` once resolved (`/events/../admin` is `/admin`). It's fetched from this deployment's site URL (`getSiteUrl()`) with no cookies or credentials, redirects followed only to another allowed path on the same site (at most 3), at most 2 MB, 10 s. The site streams its pages, so the hidden streamed segments are moved into place (React's `$RC`/`$RS`) before the text is read from `<main>` (`search/html-text.ts`).
- `recruiting_pipeline` (deferred): a round's pipeline (`src/server/queries/recruiting-pipeline.ts`): rounds; team applications per team and status; unreviewed (no reviews and no decision yet); scores per team (average and 1–5 counts); reviewer load; with `applicants` (or a team, status or unreviewed filter) the applicants with a link to each. `contact: true` adds emails and EIDs, and only then are they even selected.
- `race_performance` (deferred): from uploaded results (`src/lib/race-performance.ts`, loaded by `src/server/queries/race-performance.ts`). Focus `overview` (finishes, points, positions gained, incidents, lap spread per driver), `laps` (best and average clean laps by track and driver), `incidents`, `positions`, `rounds` (winner and fastest lap per round), `trend` (one driver), `head_to_head` (two drivers). Scope: a season's rounds (its series' events between its dates, as the standings count them) or `season: "all"`, filtered by track or round. **Clean laps** are valid (no cuts), not a driver's first lap of the session, and within 107% of their best. Every result carries `dataLimits`: no DNF is recorded, `classPosition` is always 0, laps have no running position, positions gained needs a qualifying session uploaded for the same event.

**Privacy (design §3.2):**
- `recruiting_pipeline` reads SUBMITTED applications only. Applications from anyone holding the officer or admin role keep only that they applied (name, date): their teams, statuses, reviews and decisions are left out of every list and count. The same rule as Jack's SQL role and the `audit_log` tool.
- The admin page's panel uses the page's own rule instead (everyone counted; the viewing officer's own reviews left out), the same as its list. Since the viewer can't see those reviews, their own application isn't counted under "No review yet" or in the longest wait either.
- Race data selects members through `publicUserSelect`; the public profile loads only public events' sessions.

**Admin and site:**
- **Rooms list** (`/admin/jack?q=…`): a search box over room names and every message (Jack's answers included, labelled "Answer"), linking each message to `/admin/jack/<room>?m=<message>`. Archived rooms are left out until they can be opened (decks-rooms).
- **Message anchors**: `?m=<id>` makes `getRoomSnapshot(roomId, { around })` hold that message with 40 before it: the latest 500 when they already do, else a window of the same 500 (40 before it, it and 459 after) and the `gap` it leaves before the newest. The room view scrolls the message to the middle, highlights it and doesn't follow the end until the officer sends. With a gap, a divider after the window says how many newer messages weren't loaded and links to the latest (`/admin/jack/<room>`); the page's later snapshots don't fill the gap in (`lib/jack/room-gap.ts`), and new messages still arrive live after the divider.
- **Recruiting** (`/admin/recruiting`): a Pipeline panel above the list: team applications per team and status, "No review yet" (never the viewer's own application), average scores, reviews per officer and the longest wait.
- **Results** (`/admin/results`): Best laps and form under the uploads: the fastest lap at each track in any ingested session, and each recent driver's last five finishes (from the last ten races) with positions gained.
- **Public driver profile** (`/drivers/<handle>`): Recent form (last five races, average finish, places gained or lost from qualifying) and Best laps (the fastest lap at each track, linked to its event), from public events only.

**Prompt and notes:**
- `prompt-sections/club-data.ts`: when to search and read, citing, Jack's earlier answers as leads only, the two deferred tools and the officer-applicant rule. Pages: adds the Recruiting page (it existed but wasn't listed).
- `tools/schema-notes-slots/club-data.ts`: recruiting tables and race detail for `describe_schema` (no DNF, `classPosition` 0, how seasons find their rounds, positions gained). The core note on `RaceResult.status` now says DNF is never recorded.
- Digest check `recruiting.unreviewed` (`automation/checks/club-data.ts`, order 60): team applications with no review and no decision, per team, in the active round and rounds closed in the last 30 days; counts and team names only, officers' applications not counted; a warning once one has waited over 7 days.

## Environment and setup
- No new env vars and no setup steps. `JackSearchDoc` and its triggers come from G1's migrations.
- `read` on site pages fetches from `getSiteUrl()`: `NEXT_PUBLIC_SITE_URL`, else the canonical address in production or the deployment's own URL on previews (previews behind Vercel's protection answer 401, which `read` reports), else `http://localhost:3000`.
- Teams results appear only after an admin switches the `teams` connector on (Connections page, G2; the documents track syncs the messages).

## Trying it locally
```bash
cd apps/platform
# every Jack tool once against the local database, these four included (site_page needs the site running)
pnpm exec tsx scripts/try-jack-tools.ts
# the database side: search SQL and triggers, readers, the pipeline rules, race data, anchors.
# Writes only rows it creates (tagged with one random word) and deletes them; never touches ConnectorState
NODE_ENV=production pnpm exec tsx scripts/check-jack-club-data.ts
```
Then, with `pnpm dev`: `/admin/jack?q=<words>` and a result's link, `/admin/recruiting`, `/admin/results`, and `/drivers/<handle>` for a driver with results.

## Tests
`src/server/jack/search/*.test.ts` (every source and reader against mocked raw SQL, the merge, the path guard and cookieless fetch, streamed HTML, paging and passages), `src/server/jack/tools/{search,recruiting-pipeline,race-performance}.test.ts`, `src/lib/race-performance.test.ts`, `src/server/queries/{recruiting-pipeline,race-performance}.test.ts`, `src/server/jack/room-search.test.ts` (anchor snapshots and the rooms list search), `src/lib/jack/room-gap.test.ts`, `src/server/automation/checks/club-data.test.ts`, and `tools/registry/club-data.test.ts` (order, deferred flags, and the track's tool-definition budget, 12,000 characters; about 8,400 now).

## Notes for other tracks
- **memory (T2):** knowledge hits link to the entry's page, `/admin/knowledge/<id>` (`knowledgeHref` in `search/links.ts` uses the memory track's `knowledgeEntryPath`; the first version linked `/admin/knowledge?entry=<id>`, which the Knowledge page doesn't read). `read` on a knowledge entry returns `meta.versionId` (the newest `KnowledgeEntryVersion`) for `baseVersionId`, plus `ageDays` and `notReviewed`; the age rule ("mention it past 180 days") belongs in the memory prompt section.
- **documents (T6):** the `documents` and `teams` sources only read `ExternalDocument` and `TeamsMessage`/`TeamsChannel`. The Teams switch is read straight from `ConnectorState` (`teamsEnabled()` in `sources/teams.ts`); once the Teams connector is registered it can go through the connector's `enabled()`. Teams links are built as `https://teams.microsoft.com/l/message/<channel>/<message>?groupId=<team>&parentMessageId=<root>`; if the sync stores Graph's `webUrl`, prefer it.
- **discord-read (T7):** fill `search/slots/discord-read.ts` with a `SearchSource` (live search; `unavailable()` when the connector is off; readers optional). The `search` tool's `sources` enum and the `read` types pick it up from the registry.
- **decks-rooms (T9):** the rooms list takes the search as a `search` node above the rooms (`JackRoomList`); the archived filter and pins can sit beside it. Search results and `?m=` links can point into archived rooms (Jack's search includes them; the rooms list search doesn't, `includeArchived: false`): the archived read-only view should pass `around` to the snapshot too, and the snapshot's `gap` to the room view.
- **automation (T11):** the digest check is `recruiting.unreviewed`; its items carry team names and counts only.
- **eval (E):** these are in `scripts/jack-eval/tracks/club-data.ts` (PR I; eval.md lists them): the sponsor tiers decision (with a fake decision entry in `seed/club-data.ts`), the LSC rules on penalties, unreviewed Media applications, the officer-applicant privacy case, the most consistent driver, the top two head to head (picked from the data, since a question's text can't wait on the database), and `/admin/users` through read (refused).
