## Findings

1. **Major · §6 Scheduler (cron secret).** The design sends `Authorization: Bearer <secret>` through pg_net and says this is safe because "the secret never appears in `cron.job`." Our own research shows the header can still be read. `research/supabase-pg-cron.md` §6.1, verified locally: "Every login role can read and write pg_net's queue, including `jack_readonly`… a queued request's headers, including a Vault value written into a header, can be read by Jack's SQL tool." The grant can't be revoked because `supabase_admin` owns the queue.
   - Installing pg_net also gives every role (`EXECUTE` to PUBLIC) a way to send outbound HTTP (`net.http_get/post`). Today only `run_sql`'s READ ONLY transaction stops Jack's role from using it.
   - Separately, `codebase-infra.md` §2 says to add `net` to the jack_readonly USAGE self-check. If G1 follows that advice, the migration RAISEs in prod and won't ship.
   - **Fix:**
     - Use the researched HMAC scheme instead: `X-LSR-Timestamp` plus `X-LSR-Signature`, a 300 s window, and its own `SCHEDULER_SIGNING_SECRET` (not the shared `CRON_SECRET`), with `_PREVIOUS` accepted during rotation.
     - Add `net`, `http_get`, `http_post` and `http_delete` to `isOffLimitsName` in `run_sql`.
     - Add `cron` and `scheduler` to the self-check, but not `net`.
     - Make the tick route return only counts, because `net._http_response` is readable for 6 hours.

2. **Major · §1 principle 8, §3 "Nothing here holds secrets", §3.6.** This statement is false for the planned connectors.
   - Twitch needs a stored, rotating user refresh token (`moderator:read:followers`) and a cached app token. `twitch.md` L45: "keep the user refresh token and the cached app token in a DB table… Keep that table out of the `jack_readonly` grants."
   - The Graph and Google access tokens will also be cached.
   - The design gives these no home. The obvious places, `ConnectorState.cursor` and `ScheduledJob.config`, are tables Jack can read with `run_sql`.
   - **Fix:** add a `ConnectorSecret` table, or `SystemSetting` keys, revoked from `jack_readonly` with a `has_table_privilege` RAISE check in the creating migration. Forbid tokens in `cursor`, `config` and error columns. Change principle 8 so it lists every table that holds a credential.

3. **Major · §10 Site traffic.** The design leaves the choice to the track, and the research has already found the API: it needs a Vercel project-scoped token, which is **read and write** on the production project. `vercel-analytics.md` §2: "In theory it can touch deployments, domains and env vars of the prod project… assume it can [read decrypted env values]."
   - §2 also has Jack's `site_traffic` tool fetch "live", so this token sits behind a code path Jack can call.
   - That breaks "keys are read-only or restricted" (#188 and principle 1.8).
   - **Fix:** decide in the design. Prefer the first-party page-view counter. If the token is used anyway, treat it as a documented exception:
     - mark every prod secret as a Sensitive env var;
     - give the token a short expiry;
     - wrap it in a client that allows only the two `GET /v1/query/web-analytics/...` paths;
     - use it only in the daily snapshot job, and have Jack's tool read our snapshot table.

4. **Major · §4.1 Apply flow (double-apply and atomicity).** Step 2 locks the proposal row `FOR UPDATE`, and steps 6 to 9 then run the kind's service.
   - Several applies are long or call outside services: `sendBulkNotification`, a Discord POST, Instagram's container then poll then `media_publish`, and `ingestUpload`, which opens its own transaction with its own lock (`codebase-admin.md` §3).
   - That doesn't work inside a Prisma interactive transaction: the default timeout is 5 s, nested transactions aren't supported, and external calls can't be rolled back.
   - If the lock is released before the side effects, or the final status write fails, the proposal stays PENDING after it has been sent, and a second Apply sends again.
   - **Fix:**
     - Claim with a compare-and-set (`UPDATE … SET status='APPLYING' WHERE id=$1 AND status='PENDING'`), then run `checkStale` and the apply outside any transaction, then set APPLIED or FAILED.
     - Add `APPLYING` to the enum, plus a sweeper that turns APPLYING rows older than a few minutes into FAILED ("check before retrying"), with no automatic retry.
     - Give every kind with outside effects an idempotency key derived from `proposalId`:
       - `DiscordPost.dedupeKey = proposal:<id>`, plus an `enforce_nonce` hash;
       - `proposalId` in the Notification metadata, checked before sending;
       - an `InstagramPublish` row saved with the container id before `media_publish`.

5. **Major · §5 Files in rooms.** The upload and serving rules are too loose for a store that already holds deck renders. As written, an officer who uploads a sponsor's `logo.svg` (common) creates stored XSS on our admin origin. Any admin who opens the attachment runs it with their session, and that session can call server actions such as `updateUser` (role changes).
   - `allowedContentTypes` checks only the declared type (`vercel-blob-client-upload.md` §6.2: content sniffing "likely absent").
   - The browser chooses the pathname in the token request.
   - The shared store's `put` uses `allowOverwrite: true` (`src/server/jack/decks/storage.ts` L56).
   - **Fix:** specify all of the following.
     - Create the `JackFile` row first, then issue a PUT token for exactly `jack-files/<roomId>/<id>/<sanitized name>`, with `addRandomSuffix: true` and `allowOverwrite: false`.
     - `registerJackFile` rejects any pathname other than the one issued for that id.
     - Check magic bytes.
     - The allow-list excludes SVG, HTML/XHTML/XML, macro formats (`.xlsm`, `.docm`), archives and executables.
     - The serving route looks files up by `JackFile.id`, never by a path. It sends `Content-Disposition: attachment` for everything except raster images, plus `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cache-Control: private, no-store`.
     - The local upload route refuses to run when `VERCEL` is set.
     - Proposals made from a file record its sha256, and apply checks it.

6. **Major · §7 web search/fetch, §11.** The design assumes `web_fetch` reaches only URLs from search results or from an officer. In fact it also reaches any URL in a **client tool result** (`anthropic-tools.md` §3c and gotcha 1). That includes:
   - Discord messages, Drive documents and emails;
   - recruiting `resumeUrl`/`portfolioLinks`;
   - prospect websites;
   - any `run_sql` row.

   An injected page can list one link per character and tell Jack to fetch them in order, which leaks data with no officer involved. Recurring and scheduled runs have no officer watching at all. §11's plan to set `blocked_domains` "for our own admin and API paths" won't work: path entries never match for fetch.
   - **Fix:**
     - Set `url_sources` so fetch follows only user messages and earlier search or fetch results, excluding every client tool (at minimum `run_sql`, `recruiting`, `discord`, `documents` and `room_files`).
     - Keep `max_uses` small.
     - Leave the web tools out of scheduled and recurring runs entirely, decided per request type so the cache stays intact.
     - Drop the path-based blocklist idea.

7. **Major · §3.14 digest, §6, §11 "every post is a proposal or a standing rule".** The design never says who writes the weekly digest it posts to Discord and Teams.
   - If Jack writes it, outside text gets posted without any Apply: an injected Discord message, email event, web page or prospect note can end up in the post.
   - Officer-only data (applicant names and scores, sponsor contact names and emails, member emails and EIDs) would also go to Discord and to UT's Teams tenant, whose audiences are not "every officer".
   - The design also doesn't say who the digest runs as, and that identity is what the recruiting filters key on.
   - **Fix:**
     - The Discord and Teams digests are fixed templates over our own tables: counts, plus links to admin pages, no free text from outside sources, and no personal data.
     - Any version Jack writes goes only to the room.
     - Standing-rule posts are templates, never model output at send time.
     - Scheduled runs name an actor and get neither knowledge saves nor web tools.

8. **Major · §3.3 and §7 memory (knowledge saves).** `knowledge.save` is the one write that outside content can trigger with nothing for an officer to press, and it lasts.
   - An injected Drive doc, Discord message or web page can get saved as "club knowledge", which Jack then cites later and the Knowledge page presents as fact.
   - Scheduled and recurring runs can save too.
   - An officer pasting a key into a room could get it saved, against #188's "never credentials".
   - #188 also says entries can be **deleted**; the model only archives, and `KnowledgeEntryVersion` keeps every past copy.
   - **Fix:**
     - Allow saves only in replies to an officer's message: not scheduled runs, not continue notes.
     - Record provenance (room, message, and the outside sources read during that reply).
     - Present knowledge results to Jack as data in the prompt.
     - Reject saves that match key patterns (`sk_`, `rk_`, `vcp_`, PEM, `Bot `, long base64).
     - Show the full saved text in the room note.
     - Add a hard delete that also removes the versions.

9. **Major · §7 recruiting, §11 "Recruiting privacy is as described in section 7".** The rule "hides reviews of the asker's own application" can't hold:
   - every room is shared;
   - `room_search` covers every room;
   - `run_sql` reads every recruiting table (`codebase-data.md` §2: "jack_readonly sees everything").

   If officer A asks about officer C's application, C can read the answer, or C can query their own reviews directly.
   - **Fix:**
     - In the tool, hide reviews, scores and decisions on any application whose applicant currently holds officer or admin, and keep the SUBMITTED-only filter.
     - Enforce the same rule for `run_sql` by tightening the existing `jack_readonly_select` policies on `ApplicationReview` and `ApplicationTrack`. Those tables already have RLS, so this is a one-migration change: `USING (NOT EXISTS (… applicant is officer …))`.
     - Keep recruiting names out of anything posted outside the site.

10. **Major · §3.8 DiscordRule, §10 Discord posting.**
    - The event rules (`new_event`, `event_mirror`, `event_reminder`) don't say which events they fire on. `draft_event` creates events with no Apply, so a rule that fires on DRAFT, `members` or `officers` events turns injected text into an automatic Discord post. The public event page deliberately keeps `meetingUrl` out of its HTML (`src/app/events/[slug]/page.tsx` L279–309).
    - `allowed_mentions` defaults to parsing `@everyone` (`discord.md` §6), and the design's rule config carries `mention: "@here"`.
    - `twitch_live` posts the Twitch stream title, which is outside text, with no approval.
    - **Fix:**
      - Rules fire only when `isEventPublic(event)` (`src/lib/events.ts` L55) is true, and never include `meetingUrl`.
      - Every send uses `allowed_mentions: {parse: []}` unless the approved rule or proposal names the ping, and the card shows that ping.
      - Strip mentions and links from outside text.
      - Grant the bot the research's permission integer (no `MENTION_EVERYONE` or `ADMINISTRATOR`).

11. **Major · §3.8 account linking and role sync.** The design says only "Discord OAuth (identify scope)." Without `state` tied to the session, an attacker can link their own Discord account to an officer's site account (login-CSRF: the officer opens the attacker's callback URL). The hourly role sync then gives the attacker's Discord account the officer role.
    - **Fix:**
      - Bind `state` to a signed session cookie, use PKCE S256, check `iss` (`discord.md` §2), revoke the user token right away, and store no tokens.
      - Relinking requires unlinking first.
      - Clear the link when the member deletes their account (`src/app/account/actions.ts` L63 only deletes the User).
      - Sync only roles that carry no moderation permissions, and keep the bot's role below admin roles.
      - Write an audit entry for every role change.

12. **Major · §3.8 and §10 Discord privacy and terms; scope gap against #188 ("A privacy note goes in the server").** The design has none of the following:
    - the server privacy note, the required Developer Portal privacy-policy URL and an updated `/privacy` page (Developer Terms §5a);
    - deletion handling: `after=` polling can't see edits or deletes (`discord.md` §6), so a message a member deleted stays quotable by Jack;
    - a retention limit, or a way for a member to have their data deleted;
    - written service-provider terms (§10a).

    Also, `DiscordMember` and `DiscordPollVote` get RLS in the design but are never modeled, and any officer can switch on sync for any channel, private ones included.
    - **Fix:**
      - Re-scan a trailing 7-day window, and hard-delete the content of messages that are gone.
      - Delete a member's messages on request or when they delete their account.
      - Set a retention window.
      - Make the channel sync switch admin-only, and list synced channels in the server note.
      - Report activity in aggregate only (Developer Policy #16).
      - Search only our synced table, never the live guild search.
      - Store poll counts, not voters.

13. **Major · §10 and §3.7 Google Drive.** "Changed files by `modifiedTime`" can't see deletions or removals.
    - Files moved out of the folder or unshared never leave the index, so `ExternalDocument.text` keeps private documents that Jack can read, against #188's "No one's private notes".
    - A `modifiedTime` query also only works per folder.
    - The service account sees anything shared to its email (`google-drive.md` L160 and L214).
    - **Fix:**
      - Use the changes feed. On `removed`, delete the row or null out `text`; setting `deletedAt` alone isn't enough.
      - Check that every file sits under the root folder.
      - Run a full re-walk reconciliation every week.
      - Alert when the root folder returns 404.

14. **Minor · §3 access rules (RLS list).** Personal data also lands in tables the design leaves without RLS:
    - `JackFile.text` (meeting transcripts, spreadsheet imports holding emails or EIDs);
    - `ExternalDocument.text`;
    - `EmailEvent.detail` (recipient addresses, click IP and user agent);
    - `SponsorActivity`;
    - `KnowledgeEntry` and `KnowledgeEntryVersion`.

    The model puts RLS on `Meeting` while the transcript itself sits in `JackFile`. Prod has no anon USAGE, so this is defense in depth. **Fix:** list the exact tables in G1, add a migration self-check that RAISEs when a listed table lacks RLS, and store only the bounce reason and click link in `EmailEvent.detail`.

15. **Minor · §3.5, §3.6, §3.8, §3.11, §4.1 error columns.** These columns are all readable by Jack: `ConnectorState.lastError`, `ScheduledJob(Run).error`, `DiscordPost.error`, `InstagramPublish.error` and `JackProposal.result`.
    - Instagram puts `access_token` in the query string (`src/lib/instagram.ts` L35–38).
    - A Teams Workflows URL carries `sig=`.
    - **Fix:** run every stored error through one `redactSecrets()`: strip query strings, mask known env values and key patterns. Add a test.

16. **Minor · §5 and §10 parsers for outside files.** "A maintained, safe parser (chosen during the build)" leaves known risks open:
    - npm `xlsx@0.18.5` has prototype-pollution and ReDoS CVEs;
    - `pdfjs-dist` before 4.2.67 has CVE-2024-4367;
    - XLSX and DOCX are zip files, so zip bombs apply.

    **Fix:** name the parsers (exceljs, or SheetJS ≥0.20.x from its CDN; `pdfjs-dist` ≥4.2.67 with `isEvalSupported: false`), and cap uncompressed size, rows and parse time.

17. **Minor · §4.3 news.create/news.update and the card.**
    - News renders as MDX with JSX allowed (`src/lib/news.ts` L88–99; pages use `format: "md"`, `src/lib/pages.ts` L16–27). A Jack-proposed post built from outside content can therefore carry `<iframe>`, `<form>` or tracking images onto the public site, while the card shows only raw markdown.
    - **Fix:** reject JSX and HTML in proposal payloads, or switch news to `md`. Show a rendered preview, and flag external links with their domain on every card, including notification `actionUrl` and Discord embeds.

18. **Minor · §7 display kinds, reply links.** `reply-text.tsx` renders `[label](url)` as an anchor that hides the URL. Injected instructions can put member data in a link's query string, and one officer click sends it out. The new `links` display has the same shape.
    - **Fix:** show the destination host next to every external link, and flag external URLs with long query strings.

19. **Minor · §7 `site_content` read.** "Read one public page of our site by path" needs a path check. A naive `new URL(path, site)` follows `//evil.com` off-site.
    - **Fix:** reuse the `safeHref` rule (`^\/(?![/\\])`), deny `/admin`, `/api`, `/account` and `/auth`, and fetch without cookies.

20. **Minor · §4.3 results.import.** The proposal has to show unmatched drivers, but `previewParseResult` upserts `DriverIdentity` and `ParseReport` (`codebase-admin.md` §3). Proposing would therefore write to the database before anyone presses Apply.
    - **Fix:** do a pure parse when proposing, and all writes in `apply`.

21. **Minor · §3.14 recurring questions.** These run "as" `createdById` with no check that the officer still holds a role.
    - **Fix:** check roles at run time, pause the question with a room note if the check fails, and set `createdById` to the officer who applied it.

22. **Minor · §12 eval (scope against #188, "every new source gets questions").** **Fix:** add an injection case for each new source (a Discord message, a Drive doc, a fetched page, an uploaded PDF, a spreadsheet cell). Each case checks that the injection produces no proposal, no knowledge save, no fetch of the injected URL and no outside link carrying data.

## Keep

1. Apply takes only the proposal id. The payload is stored on the server and validated again, permission is checked against the **applying** officer's roles, `checkStale` runs, and the audit entry records `via: "jack", proposalId, roomId, proposedFor` (§4.1).
2. All outside data is synced into our tables, connector clients sit outside `jack/`, and keys live only in env. Stripe uses a restricted read-only key, `draft_email` never sends, and there is no Discord or Teams prompt path (REST only, no interactions endpoint) (§1.3, §2, §10).
3. Webhooks are idempotent through unique delivery and dedupe keys (`EmailEvent.svixId`, `DiscordPost.dedupeKey`), the cron route fails closed, and the cron schedule and secret are a setup step rather than a migration (§3.8, §3.10, §6).
4. The Blob store is private, files are served through officer-checked routes, and Instagram gets a short-lived signed GET link. Today's `signedUrl` is scoped to one pathname and to `get` only (`storage.ts` L58–63) (§5, §10).
5. Personal-data tables get RLS plus the `jack_readonly_select` policy, the recruiting tool returns SUBMITTED applications only, and the public driver profile shows only results that are already public (§3, §7, §9).