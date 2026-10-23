## Findings

**1. Major: §12 Build plan. G2–G7 are not independent, so "can run in parallel once G1 merges" will cause conflicts and rework.**
- **G7 is needed by G4, G5 and G6.** G7 owns the display kinds in `parts.ts` and the prompt-section split. G4 needs the `proposal` display and G5 needs `files`.
- **The renderers have no owner.** `DisplayView` in `components/jack/parts/tool-part.tsx` (~L83–99) switches on `display.kind` and has `default: return null`. New kinds type-check but render nothing, and no G-step builds the renderers for `links`, `stats`, `email_draft`, `files` or `web_sources`.
- **G5 and G6 both rewrite `server/jack/history.ts`.** G6 changes the officer line to "Gray (Technology Director · …)". G5 turns officer turns from text strings into image/document block arrays. Both also change the `HistoryRow`/author select in `rooms.ts` and `reply-loop.ts` (actor at L372).
- **G4 depends on G3.** §4.1.5 says stale proposals expire "through a scheduler job".
- **G1 must freeze interfaces that later PRs are supposed to design.** The slot files (`proposals/kinds/<track>.ts`, `scheduler/jobs/<track>.ts`, connectors) can't type-check until `ProposalKind`, the job kind type and `Connector` exist. So G1 effectively fixes the interfaces of G2–G4.
- **Fix:**
  - Fold G7 into G1: the display union, generic renderers for all six kinds, the prompt split and the wiring that collects the slots.
  - G1 also ships the interface types for proposals, jobs, connectors and Overview cards.
  - Merge G6 into G5, or run G6 first: it's small.
  - Make expiry lazy: treat `expiresAt < now` as STALE when listing or applying. That removes the G3 dependency.
  - G4 ships one real kind (`page.update`: `savePage` already returns `{ok,id}`) so five tracks don't build against an untested interface.

**2. Major: §2.1 Plug-in slots. The slots cover registries, but most of the shared surface is still shared.** Files ~9 tracks will still edit:

| File(s) | Tracks that edit it |
|---|---|
| `src/lib/jack/types.ts` | G4 (`proposal.updated` event), G5 (`fileIds` on `JackMessageView`), decks-rooms (`pinnedAt`/`answerMode` on `JackRoomView`, feedback) |
| `src/lib/jack/room-state.ts` + `components/jack/use-jack-room.ts` | Same three: they hold the reducer for those events |
| `components/jack/room-view.tsx` (Composer at L475) | G5 (attach, paste, drop), decks-rooms (feedback, mention mode, pin) |
| `components/jack/room-list.tsx` | club-data (search box), decks-rooms (pin, archive) |
| `app/admin/jack/actions.ts` and `server/jack/rooms.ts` (`postOfficerMessage`) | G5 (fileIds), decks-rooms (mention gating) |
| `server/jack/model-loop.ts` + `cost.ts` | G5 (content blocks), sources (web search; see finding 9) |
| `server/jack/reply-loop.ts` | automation (scheduled runs), decks-rooms (mention mode) |
| `tools/types.ts` | G6 (`actor.profile`) |
| `src/lib/instagram.ts`, `instagram.service.ts`, `/admin/instagram` | sources (insights), decks-rooms (publishing) |
| Knowledge page | memory, documents (Documents tab) |
| `app/drivers/[handle]/edit` and `server/actions/users.ts` | G6 and memory (both claim department / "working on"), discord (account linking) |
| `package.json` / `pnpm-lock.yaml` | G3 (cron parser), G5 (XLSX/CSV), documents (PDF text, maybe `google-auth-library`), sources (`svix` as a direct dependency) |
| `.env.example`, `next.config.ts` (`images.remotePatterns` for Twitch/Discord CDNs), `docs/jack.md`, admin guide, `build-log.md` | Every track: §12 says every PR updates `docs/jack.md` |

- **Fix:**
  - Pre-add the expected dependencies in G1. Rule for lockfile conflicts: take `jack-2`'s lockfile and rerun `pnpm install`.
  - Put extension points in G1:
    - a composer attachment slot and a per-message actions slot in `room-view.tsx`;
    - the full event union in `types.ts`;
    - a tab registry for the Knowledge page.
  - Each track writes its docs and env vars to `docs/jack-2/tracks/<track>.md`. They are folded into `docs/jack.md` once, at the end.
  - Give each contested page one owner.

**3. Major: §12. PRs into `jack-2` get no CI, there's no build step, and there's no plan for keeping in step with main.**
- **No CI.** `.github/workflows/ci.yml` L5–8: `pull_request: branches: [main]`. The per-PR list (lint, typecheck, test) leaves out `pnpm build`, which catches server/client boundary and `"use server"` export errors that typecheck misses.
- **No sync with main.** #188 says Jack bug fixes keep going to main. Those fixes land in exactly the files `jack-2` rewrites: `prompt.ts` (which G7 splits), `history.ts`, `model-loop.ts`, `reply-loop.ts`, `room-view.tsx`. Nothing in the plan merges main into `jack-2`, so all of it conflicts once, at release.
- **Fix:**
  - Add `jack-2` to the CI branches in G1.
  - Add `pnpm build` to every PR's checks.
  - Merge main into `jack-2` weekly, and rebase open tracks after each merge.
  - Do the prompt split first, so main's prompt fixes only have to be ported once.

**4. Major: §12 and §6. Parallel worktrees share one local Supabase, which isn't safe as planned.**
- **Migrations can wipe the shared database.** If track A runs `prisma migrate dev`, track B (which doesn't have A's migration folder) sees drift. Non-interactive it fails; with `pnpm db:reset` (`prisma migrate reset --force`, `package.json` L20) it wipes everyone's data, including the officer roles on users.
- **The local cron can hit the wrong code.** §6 has local pg_cron call `host.docker.internal:3000`, which reaches whichever worktree holds :3000. That code may not have the job kinds other tracks registered, and they all share one `ScheduledJob` table.
- **Fix:**
  - Only G1 migrations run against the shared database during the build. Track migrations are applied by hand and must be additive.
  - Never run `db:reset` in a track worktree.
  - Don't schedule pg_cron locally: use `pnpm jack:tick` per worktree.
  - The dispatcher must skip (not claim, not fail) job kinds it doesn't know. That also covers deploys where old code meets new rows.

**5. Major: §3 Data model. "All new tables are created in the groundwork migration(s)" can't be met, and trying makes G1 a long blocker.**
- **Models are missing or only described in prose:**
  - No Teams channel-message model, though the `teams` tool searches "synced Teams channel messages" (§7).
  - `InstagramAccountDaily`, `InstagramPublish` and `JackFeedback` appear only as prose (§3.11, §3.15).
  - No analytics snapshot table: `vercel-analytics.md` recommends a daily snapshot because Hobby keeps only one month.
  - No Twitch token table: `twitch.md` L45 says the rotating user token must be stored. That also conflicts with principle 8.
  - `EmailEvent` has no recipient field and no RLS, though `resend.md` L186–194 asks for both.
- Several research docs are still in progress, so more of these will turn up.
- **Fix:**
  - G1 creates only the cross-cutting tables: proposals, files, scheduler, `ConnectorState`, knowledge, and the new User and room/message columns.
  - Each track owns its own models and migration. Use per-track `.prisma` files (Prisma's multi-file schema folder, GA since 6.7; check on 6.15) so `schema.prisma` stops being a conflict point.
  - Minor: the migration ranges use hour digits 3–8 (`202610243…` to `202610248…`), which aren't real hours, and `migrate dev` always generates real timestamps, so every track has to rename folders by hand. Real timestamps are fine because everything is additive.

**6. Major: §4.3–4.4. The changes refactors are underestimated, and the test plan can't pin their behavior.**
- **`event.update` covers four actions, not one.** It edits "details, registration, attendance, status", which in `app/admin/events/actions.ts` means `updateEvent` (L133), `updateEventStatus` (L88, which redirects), `updateEventRegistrationConfig` (L209, which calls `reconcileEventWaitlist` and promotes and notifies people) and `updateEventAttendanceConfig` (L304). §4.4 lists only `updateEvent`.
- **Parsing writes.** `previewParseResult` (`results/actions.ts` L72) upserts `DriverIdentity`. A `propose_results_import` that previews unmatched drivers would write before any officer presses Apply.
- **The ingest can't be pinned with mocks.** `ingestUpload` is a ~330-line locked transaction. Hoisted `vi.fn` Prisma fakes can't pin its behavior, and CLAUDE.md says database-dependent code isn't covered.
- **Fix:**
  - Split changes into a refactor-only PR first, with no new behavior, landed right after G1.
  - Pin behavior with a golden-file DB check script (`scripts/check-results-service.ts`): run real AC fixtures through upload, parse, bind and ingest, then diff the rows before and after the refactor.
  - Add a pure, write-free parse for previews.
  - Option for Gray: let these behavior-preserving refactors go to main early, so live admin paths don't diverge for weeks.

**7. Major: §2.1 and §4.3. Cross-track dependencies are ignored; the tracks are not parallel.**

| Dependency | Evidence |
|---|---|
| changes' `import.rows` needs sponsors-meetings' prospects and action items | §4.3 L513 |
| `meeting.record` writes the decision log, so sponsors-meetings needs memory's knowledge service, plus G5 for transcripts | §3.13 `knowledgeEntryId` |
| Prospect research needs web search (sources) | |
| discord's `twitch_live` rule needs the sources track's Twitch EventSub | §3.8 |
| The automation digest needs discord posting, a Teams poster (no track owns it), action items and prospects | |
| Ownership is duplicated: Proposals page (§9 changes vs §12 G4), profile fields (§9 memory vs G6), `room_files` (§7 changes vs §5, where G5's text files depend on it) | |

- **Fix:**
  - Add adapter slots so dependent work plugs in instead of reaching across tracks:
    - `proposals/import-targets/<track>.ts`, so sponsors-meetings registers its own import targets;
    - `automation/digest-checks/<track>.ts`, so each track contributes its "needs attention" checks;
    - discord rules detect changes by polling (`RaceSession.createdAt`, `Event.updatedAt`) instead of hooks in services that changes is refactoring.
  - Give each duplicated item one owner.
  - Run automation last.

**8. Major: §6 Scheduler. As designed it can't host Jack runs, and its auth leaks the secret.**
- **Jack runs don't fit.** Everything due runs in one tick's `after()`, inside one 300 s function. A recurring question or the digest is a full reply, and the reply loop "starts only with at least 150 s of the run left" (`docs/jack.md`, Function duration). `supabase-pg-cron.md` §3.6 point 6 says to give long jobs their own signed POST.
- **The secret leaks.** §6 sends `Authorization: Bearer <secret>` through pg_net. `supabase-pg-cron.md` §6.1 (verified locally) says every role, `jack_readonly` included, can read `net.http_request_queue` headers, and `run_sql` doesn't block `net.*`. That breaks principle 8.
- **Fix (G3, before automation starts):**
  - Hand each Jack-run job off to its own invocation, with a deadline the reply loop understands.
  - Use HMAC with a timestamp, as the research specifies, not a bearer secret.

**9. Major: §7. Web search and tool search need model-loop changes the slots can't hold, and the measurement comes too late.**
- **Server tools don't fit the slots.** `toolDefinitions(tools: AnyJackTool[])` (`model-loop.ts` L436) only knows our own tools. Server tools need new tool entries, handling for `server_tool_use` and result blocks, how they count against the call cap, and per-search cost in `cost.ts`. That is core-loop work given to the sources track.
- **The measurement happens before the tools exist.** "The groundwork PR measures the cached prefix" (L594), but at groundwork the slots are empty. Moving tools behind `defer_loading` would then happen at the end and touch every track's tools.
- **Fix:**
  - Groundwork adds server-tool support and a `deferred?` flag on `JackTool`.
  - Give each track a budget for its tool definitions plus prompt section, enforced by a size test.
  - Re-measure after each track merges.

**10. Major: §2.1 prompt sections. The core prompt contradicts proposals, and every track needs to edit it.**
- **Contradictory rules.** `prompt.ts` says "You are read-only with club data… You can't send email or messages, post anywhere…", and `prompt.test.ts` asserts `/read-only/`. Appending track sections that say "you can propose posts" gives the model conflicting rules.
- **A shared list.** "Where officers make changes" needs a line for each new page (Knowledge, Discord, Sponsors, Meetings, Proposals and others), and that list is core text every track would edit.
- **Fix:**
  - G1 rewrites the "can't do" rules once, around proposals.
  - The "where" lines move into each track's prompt slot.

**11. Major: §12 End. Real accounts, webhooks and the release aren't in the plan, so the release could ship things that have never run against the real service.**
- **Access is unowned.** #188's access steps (bot added, Drive shared, Twitch app, restricted Stripe key, analytics token, UT IT request) have no owner or dates.
- **Webhooks only work on prod.** Twitch EventSub (challenge handshake), Resend's Svix webhook and the Blob callback need a public URL. Previews can't sign in, and Vercel protects them.
- **Not yet confirmed.** pg_cron on the hosted plan is UNVERIFIED (`supabase-pg-cron.md` §5). A single release would apply ~15 migrations at once.
- **Fix:**
  - Add an accounts-and-access track with owners and dates.
  - Write an opt-in live smoke script per connector (the research docs already sketch them).
  - Connectors ship disabled until their smoke test passes.
  - Rehearse the release migrations on a prod-like Supabase project; `lsr_eval` skips the pg_cron guard.

**12. Minor: §10. The fake strategy isn't settled.** §10 puts in-process fakes next to each client. `stripe.md` (L300: "Make the fake an HTTP server, not a mocked client"), `resend.md` (L244) and `anthropic-tools.md` (L225) prescribe HTTP fakes behind base-URL env vars. Tracks following their research doc will build the other kind. **Fix:** G2 picks one; HTTP fakes are better because they exercise the real SDKs.

**13. Minor: §12 tests and eval. Database-only behavior and the eval harness have no owners.**
- **Untested database behavior.** Concurrent Apply (`FOR UPDATE`), RLS on the new personal-data tables, tsvector search and `check-jack-sql-role.ts` updates (`cron`/`scheduler` schemas) all need database check scripts, and none are planned.
- **The eval harness isn't ready.** Its cleanup (`scripts/jack-eval.ts` L723–731) only deletes DRAFT events. Knowledge saves (no room FK) and proposals will pile up in `lsr_eval` and change later runs.
- **Missing pieces.** Fake connector data has to be seeded into `lsr_eval`. Paired-officer questions need `--as` per question.
- **Fix:** add a `scripts/jack-eval/<track>.ts` slot and an eval-harness PR in groundwork.

**14. Minor: §3.15. Mention mode is underestimated.** Unanswered messages (`answeredById: null`, the answerable-message query in `reply-loop.ts` L101) would trigger the "Jack stopped before answering" stall bar after about 20 s, and a later mention would answer all of them at once. **Fix:** the run trigger, the stall detector and history all need changes; size it as more than a toggle.

**15. Minor: scope gaps against #188.**
- No track owns "officers' photos can go into decks": the renderer's allow-list doesn't serve room files.
- No track owns Teams posting (the digest).
- No transcript intake path is defined: VTT/DOCX aren't in G5's file types.
- The `stripe` tool leaves out "charges".

## Suggested sizes and order
- **Largest:**
  - **sources (XL):** six services, two webhooks, three admin pages, and model-loop changes for web search. Split it into Stripe/Resend/analytics and Twitch/Instagram, and move web search into groundwork.
  - **discord (XL):** split into read (sync, polls, linking, Discord page) and post (rules, mirror, role sync, Announcements).
  - **changes (XL):** split into refactors, then kinds.
- **Large:** G5, documents, sponsors-meetings, decks-rooms.
- **Medium:** club-data, memory.
- **Medium but last:** automation.
- **Order:**
  1. G1, including G7, CI and the dependencies.
  2. In parallel:
     - G2, G3, G4 (with `page.update`) and G5+G6;
     - started early because they don't need G2–G6: club-data, memory, and the changes refactor PR.
  3. sources, documents, discord-read, changes kinds, decks-rooms.
  4. discord-post, sponsors-meetings.
  5. automation, the eval, the security pass.

## Keep
1. Connectors live outside `jack/`, and the admin pages call the same clients and tables Jack does. Synced data is read from our own tables, not fetched live.
2. A single apply path: lock the proposal row, re-validate, check staleness, check permission against the officer who applies, write the audit log with `via: "jack"`.
3. Per-track registries joined in a fixed order after today's tools, so the cached prefix stays stable. The idea is right; it just needs to cover more.
4. `registerJackFile` doesn't rely on the Blob completion callback, and uploads use `handleUploadPresigned`. That works locally and with OIDC.
5. Moving admin logic into services both Jack and the admin pages call, with behavior-pinning tests and browser checks, and every source switchable to "not connected".