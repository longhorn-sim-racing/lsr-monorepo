## Findings

1. **Major, §3 / §7 / §9 / §10 (Teams and SharePoint reading).** The `teams` tool says it will "Search the synced Teams channel messages", but nothing in the design holds or fills those messages:
   - §3 has no Teams message table.
   - §2's webhook list covers only twitch, resend and blob uploads, so there is no inbound Graph route.
   - §9 has no Teams surface; it only has "a Documents tab listing synced Drive/SharePoint files". That breaks principle 7.
   - `research/microsoft-graph.md` §5 says: "If your app polls… you can only do that once per day." Teams messages therefore need change notifications plus one daily delta, and the design's plain sync job would break Microsoft's terms.
   - The env list is missing `MS_CHANNEL_IDS`, `MS_DRIVE_ID` and `MS_GRAPH_CLIENT_STATE`.

   **Fix:**
   - Add `TeamsChannel` and `TeamsMessage` to G1, with RLS, the Jack read policy and `deletedAt`.
   - Add `/api/webhooks/graph` plus a lifecycle route. Both check `clientState` in constant time, write a row and return 202 within 3 s.
   - Add a job that renews subscriptions about every 48 h, and a once-a-day delta reconcile.
   - Add a Teams messages tab, with search, to Knowledge or Community.
   - Keep all of it behind `ConnectorState`, disabled by default.

2. **Major, §3.13 / §5 (meeting transcripts).** #188 says Teams covers "the digest in a channel, and meeting transcripts". The design only has `Meeting.transcriptFileId // JackFile` and never says how a transcript gets from Teams to Jack.
   - §5 extracts text only from "CSV, JSON, plain text, spreadsheet → CSV".
   - A Teams recap download is `.vtt` or `.docx` (research §3h). A `.docx` would land as `JackFileKind.OTHER` with no text.

   **Fix:** state three paths.
   - Always available: upload a `.vtt`, `.docx` or `.txt` to a room. Add VTT parsing that keeps speakers, and DOCX text extraction.
   - If SharePoint is approved: pick transcripts up from a "Transcripts" folder through `ExternalDocument`. This is the research's recommended fallback.
   - The Graph transcript API only if UT IT grants it. Put research §9 item 6 into the setup list.

3. **Major, §3.3 / §12 End (knowledge seed).** The design only says "the knowledge seed for Gray's review". Missing:
   - where the drafts live and how they get into prod;
   - how the "one pass" review works. `KnowledgeEntry` has no draft or approved state, so anything loaded is live at once;
   - #188's topic list: club, who does what, decision log, policies, brand, sponsors, events playbook, recruiting, services plus who holds access, calendar rhythm;
   - checks for "names only, never credentials" and "no one's private notes";
   - how Teams posts get read if the Teams connector is never approved.

   **Staleness bug:** the age warning ("over 180 days old") is keyed on `updatedAt`. Every seed entry is created at launch, so a fact drafted from a 2025 Teams post looks fresh. `sourceNote` is free text with no date.

   **Fix:**
   - Add `sourceDate` (and `reviewedAt`), and compute age from those.
   - Keep seed drafts as reviewed files plus a `scripts/jack-knowledge-seed.ts` that runs only after Gray signs off, with a lint for emails, keys and tokens.
   - Put a coverage checklist in `build-log.md`.
   - Define the decision log as one entry per decision tagged `decision`, linked from `MeetingDecision.knowledgeEntryId`.

4. **Major, §3.15 (rooms: archive, and answering only when mentioned).**
   - **(a) Archive.** #188 wants "pin and archive", and room search over "archived ones included, linking to the matching message".
     - No archive action exists today. `listRooms` filters `archivedAt: null`, and `getRoomSnapshot` uses `findFirst({ where: { id, archivedAt: null } })` and then `notFound()` (`src/server/jack/rooms.ts:15,48`).
     - The design adds only `pinnedAt`. So `room_search` links into archived rooms return 404, and archived rooms become visible only through Jack, which breaks principle 7.
     - Snapshots load only the latest 500 messages (`SNAPSHOT_LIMIT = 500`), so a link to an older message can't land on it.
     - **Fix:** archive and unarchive actions with an audit entry and a room note; an "Archived" filter on the rooms list; a read-only view of archived rooms; message anchors (`?m=<id>`) that load the messages around the target.
   - **(b) "Answer only when mentioned".** Only `answerMode @default("always")` is specified. Today every post starts `runRoom()`, `findUnanswered` takes every message with `answeredById: null`, and `stallCandidate` returns `"unanswered"` for any unanswered user message (`src/lib/jack/room-state.ts:322`). In mention mode, every ordinary message would show "Jack stopped before answering" and then get swept into the next answer.
     - **Fix:** parse mentions on the server; flag messages that don't mention Jack as not needing an answer; leave them out of `findUnanswered` and `stallCandidate` but keep them in the history as context; add tests.

5. **Major, §9 (Publish to Instagram button on the deck page).** #188 asks for "a Publish to Instagram button on the deck page (an officer presses it) with Jack's caption". The design only offers `instagram.publish` and `gallery.add` as room proposals, and §9 changes nothing on the Decks page.
   - **Fix:** add to the deck page Publish to Instagram (pick slides, post, carousel or story, with Jack's latest caption prefilled and editable) and Add to gallery. Both should call the same service as the proposal kinds and write `InstagramPublish.approvedById`. Show publish history on the Instagram page.

6. **Major, §5 / §11 (officers' photos can't reach a slide).** #188 says "officers' photos can go into decks", but §11 keeps the existing renderer allow-list.
   - `resolveJackAsset` only serves `/files/<name>` from the `jack/assets/` prefix, and only `png` or `jpg` (`src/server/jack/decks/renders.ts`).
   - Room files live at `jack-files/<roomId>/<id>/<filename>`.
   - The design guide (`design-guide.ts:29`) tells Jack images only come from the site, Cloudinary, QR codes and screenshots.
   - Phone photos are often HEIC or larger than 10 MB.

   As designed, this item can't ship.

   **Fix:** add an action that copies a READY room image into `jack/assets/<fileId>.jpg`, converted to JPEG, with EXIF stripped and the long edge capped at 2560 px. Return the `https://jack.assets/files/...` URL, update the guide, and allow HEIC/HEIF uploads with conversion.

7. **Major, §10 site traffic vs principle 8.** The design says site traffic is fetched live, with a fallback "if there's no supported API".
   - `research/vercel-analytics.md` says the API exists (GA 2026-05-18) but Hobby keeps only 1 month. A live-only read leaves Jack and the Overview card blind beyond 30 days.
   - The project-scoped token "is read AND write on that project… no read-only token option", which conflicts with #188's "read-only or restricted" rule.
   - The token has to be created by the account that owns the LSR Hobby team; a live check returned 403.

   **Fix:**
   - Drop the counter fallback.
   - Add a `SiteTrafficDaily` table and a daily snapshot job, with a client that only allows the two GET paths.
   - Log the token exception as a Decision for Gray, and add it to setup with a one-year expiry and a reminder.

8. **Major, §10 / §3.11 (Instagram token scope).** "Reconnecting with those scopes is a setup step" gives the hourly sync token publish rights, so it is no longer read-only.
   - The research recommends two tokens from two Meta apps.
   - A publish token expires every 60 days, so it can't live in Vercel env. But principle 8 allows only the existing Instagram setting to hold a credential.
   - `InstagramAccountDaily.profileViews` uses a metric the research says isn't current.

   **Fix:**
   - Keep the read token (basic plus insights) in SystemSetting `"instagram"`.
   - Put the publish token in a second setting that `jack_readonly` can't read, refreshed by the existing weekly job and used only by the apply path. Amend principle 8 to allow it.
   - Replace `profileViews` with the `followers_count` field and `follows_and_unfollows`.

9. **Major, §3.14 / §11 (the digest is an unapproved post).** The digest is only "a built-in ScheduledJob… which checks, which room, Discord channel, Teams on or off". The checks aren't listed, and the design doesn't say whether the text is model-written or who turned it on.
   - §11 claims "every post is a proposal or a standing rule an officer set up".
   - In practice, a built-in job would post model-written text, drawn from synced Discord, email and document content, to Discord and Teams every week. Injected content could steer it, and no officer approves it.

   **Fix:**
   - Ship `digest.weekly` disabled. Turning it on, with its channels, is an officer action recorded with who did it.
   - Discord and Teams posts are built from a template of query results (counts, titles, links). Any model-written summary goes only to the room.
   - List the checks: pending proposals, overdue action items by owner, quiet prospects, missing results, draft events, low registrations, bounces, unreviewed applications, job and connector errors, stale knowledge.
   - Apply the same rule to `DiscordRule` posts: template text only.

10. **Major, §7 / §11 (`run_sql` gets around the recruiting privacy rule).** #188 asks for recruiting "database notes", but the design protects recruiting privacy only inside the `recruiting` tool.
    - The recruiting migration gives `jack_readonly_select … USING (true)` on all six tables (`20261015000000_add_recruiting/migration.sql:208`).
    - The app hides an officer's own reviews (`application.repo.ts:124,193`), but schema notes will teach Jack to query `ApplicationReview` and DRAFT applications directly.

    **Fix:**
    - In `run_sql`, `SET LOCAL jack.actor_user_id` inside the existing read-only transaction.
    - Rewrite the `jack_readonly` recruiting policies to hide DRAFT applications and anything about the asker's own application.
    - Add an eval safety question asked by an officer who is also an applicant.

11. **Major, §12 / §8 (eval).** #188 requires questions "for every new source". The design only has §8's paired questions and "eval on lsr_eval with fakes". Missing:
    - a per-track rule to add questions in `scripts/jack-eval/`;
    - how the synced tables get filled on `lsr_eval` (running the fake syncs with `JACK_FAKES=all` and `pnpm jack:tick` first);
    - cleanup. Today the eval removes only the DRAFT events it made and checks that "nothing changed", but `knowledge.save` writes directly and every `propose_*` writes a `JackProposal`;
    - injection questions for each new outside source: a Discord message, a Drive document, a fetched web page, an uploaded file.

    **Fix:** make "eval questions plus fixtures" a checklist item on every PR. Extend cleanup to knowledge entries, proposals and files. Add checks that a proposal was created and nothing was applied.

12. **Major, no setup section (#188 "Before and around the build").** The design never mentions club-owned developer accounts (Google Cloud, Discord, Twitch). It also leaves out the access steps:
    - Dylan shares the Drive folder with the service account;
    - the Discord admin installs the bot (permission integer from the research);
    - the Twitch owner makes an app;
    - the restricted Stripe key;
    - the Vercel analytics token, from the account that owns the team;
    - the UT IT request (ready-to-send text in research §9).

    It also skips the external registrations that make things work: the Twitch EventSub subscription, the Resend webhook, Discord OAuth redirect URIs, Instagram re-authorization, and a Workflows flow with a co-owner. The open questions (who owns Twitch; whether the constitution and brand book are in Drive) aren't tracked, and the "pre-merge checklist in build-log.md" doesn't exist yet.

    **Fix:** add §13 "Setup and accounts" as a table: service, club-owned account, who does it, env vars, external step, how to verify (the Connections page shows ok), and whether launch can go ahead with it off. Mirror it into the Production setup section of `docs/jack.md`.

13. **Major, §3.8 / §10 Discord (privacy note and unlinking).** #188 says "A privacy note goes in the server." The design has no privacy note, no update to `/privacy`, no Unlink option and no way to delete a member's data.
    - Discord's Developer Terms (`research/discord.md` §6) require a public privacy policy and deletion on request, and they bar profiling individual users.

    **Fix:**
    - Write the server privacy note (posted with an officer's approval) and add a Discord section to `/privacy`.
    - Add an Unlink button on the profile, and a way to purge a member's synced messages on request.
    - Keep admin activity views as totals, not per-member.

14. **Minor, §3.8 schema.** RLS is promised on `DiscordMember` and `DiscordPollVote`, but neither model is defined.
    - `DiscordGuildDaily.left` needs yesterday's member snapshot (research R5), and role sync needs member roles.
    - G1 builds "the schema for section 3" with names final, so this would stall G1.

    **Fix:** define both models now.

15. **Minor, `DiscordRule` (old items announced when a rule is first turned on).** The `new_event`, `results_posted` and `standings_update` rules have no trigger defined, and nothing sends EVENT_POSTED or RESULTS_POSTED today. A job that scans for items without a `dedupeKey` would announce every past event the first time a rule is enabled.

    **Fix:** only act on items after `rule.createdAt` (or a stored cutoff), and cap posts per run.

16. **Minor, §4.3 `results.import` (writes before Apply).** Flagging unmatched drivers on the card means parsing the file when the proposal is made. Today's `previewParseResult` "upserts DriverIdentity per GUID", so calling it from the propose tool writes before an officer applies anything.

    **Fix:** give `results.service` a parse function that writes nothing, and move the DriverIdentity upsert into apply.

17. **Minor, §7 / §9 (coverage gaps against the #188 wording).**
    - **Recruiting tool:** "interviews" isn't mentioned. INTERVIEW is only a status, plus `schedulingUrl`.
    - **Race performance:** the spec doesn't list best and average laps by track and round, consistency, or positions gained. It also doesn't note the data limits: DNF is never written, `classPosition` is always 0, and positions gained can only come from qualifying vs race.
    - **Stripe:** "charges" is missing from both the tool and the Payments panel.
    - **Admin surfaces with no home:**
      - Recruiting email delivery (`ApplicationEmail`) has no admin view.
      - `InstagramPublish` history appears nowhere.
      - The agenda "copy page" has no route.
    - **Nav:** the §9 table puts Sponsors under Business, but the text puts it under Club. G1 writes the nav, so settle it first.

18. **Minor, §3.4 departments.** The department list (Technology … Board) doesn't match the roster's `TeamId`, which is `"executive" | "business" | … | "technology"` with `board` as a separate flag (`src/app/about/roster.ts`). That makes a second source of truth.

    **Fix:** reuse `TeamId` plus the board flag, and backfill departments from the roster in `sync-officer-badges.ts`.

19. **Minor, §3.14 (budget for runs nobody is watching).** A recurring question can run on any persona at any interval, so one hourly Lift question could use up most of the $50.

    **Fix:**
    - Set a minimum interval (daily).
    - Allow only Jack and Stand, or show an estimated cost on the proposal card.
    - Skip runs when spend is near the cap.
    - Check that `createdBy` is still an officer at run time.
    - Don't allow `knowledge.save` in scheduled runs.

## Keep

1. **§4.1 apply path.** It runs `requireOfficer`, locks the proposal `FOR UPDATE`, re-validates the payload, runs `checkStale` against `before`, checks permission with the applying officer's roles, and writes the audit entry with `via: "jack"`, `proposalId` and `proposedFor`. The room note lets Jack learn the outcome. This is #188's approval rule made concrete.
2. **§2 shared connectors.** Connectors sit outside `jack/`, the admin pages use the same clients, and both read synced tables. That is what makes "Jack is never the only way" hold.
3. **§1.10 / §10 on-off switches.** Every service has fakes (`JACK_FAKES`), `configured()` and `enabled()`, and says "not connected" when off; Teams is off by default. That makes "built to switch off" real and testable.
4. **§6 scheduler.** One pg_cron tick, the secret held in Vault and never in `cron.job`, the fail-closed `isAuthorizedCronRequest`, jobs claimed with a lock and able to resume, the schedule as a setup script rather than a migration, and the guarded extension migration.
5. **§2.1 and §4.4 build discipline.** Each track gets its own slot files; new tools are appended after today's tools in a fixed order, which keeps the prompt cache; `DiscordPost.dedupeKey` and the approver record on outbound posts; and the live admin-path refactors ship with tests that pin today's behaviour.