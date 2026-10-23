Docs and env notes for the decks-rooms track; folded into docs/jack.md at the end. The rooms (T9a) come first; Instagram publishing and the gallery (T9b) are [after them](#instagram-publishing-and-the-gallery-t9b).

# Rooms: archive, pin, mention mode, ratings and the Usage page (T9a)

Design §10 (all but message anchors and room search, which T1 shipped) and the §13 rows for Jack → Rooms list and Jack → Usage. Code paths are relative to `apps/platform/`. The columns were already in G1's schema (`JackRoom.archivedAt`, `pinnedAt`, `answerMode`; `JackMessage.expectsAnswer`; `JackFeedback`): **no migration in this PR**.

## What officers get

**The room's menu** (the "…" in a room's header; `RoomSettingsMenu` in `src/components/jack/room-settings.tsx`):
- **Pin room to the top / Unpin room.** Pinned rooms sort first in the rooms list and the rail beside a room (pins are shared, like the rooms). No room note; audited.
- **Answer only when mentioned / Answer every message** (mention mode, below). A room note ("Gray set this room to answer only messages that mention @Jack") and an audit entry. A "Mentions only" badge sits in the header while it's on, and the composer says how to ask.
- **Archive room.** A room note ("Gray archived this room") and an audit entry. Everyone in the room sees it go read-only live.

**Archived rooms**
- Read-only: the composer is replaced by an "Archived — unarchive to continue" bar with an **Unarchive** button; renaming, switching the persona, rating replies and applying or discarding proposals are off, and the room never offers "Ask him to continue".
- They still open from links: `?m=` links from search land on their message (the snapshot loads archived rooms and takes `around`, and the gap divider works as before).
- **No Jack run starts in one** (server side): the reply loop's "waiting" query requires the room not to be archived, so a run finds nothing and lets go of the lock. A reply already streaming when the room is archived finishes; nothing after it starts, and a deck reply that stops at its limits leaves no continue note there. Posting, persona switches, renames, pins, mode changes and uploads are refused ("This room is archived. Unarchive it to continue.").
- A message left waiting when the room was archived is answered by the next run after it's unarchived (the next post, or "Ask him to continue").
- The rooms list has an **In use / Archived** switch (`/admin/jack?view=archived`, most recently archived first). Its search (T1's) now includes archived rooms and their messages, marked "Archived"; Jack's own `search` already did.
- Each row on the rooms list has a menu: Pin to the top / Unpin and Archive, or Unarchive for an archived room.

**Mention mode** (`answerMode: "mention"`, design §10)
- `postOfficerMessage` (`src/server/jack/rooms.ts`) parses the message with `mentionsAssistant` (`src/lib/jack/mentions.ts`): `@Jack`, or `@` and the name of the persona answering the room (`@Lift` in a Lift room), any case, as a word of its own (not `gray@jack.example`, not `@jackson`).
- A message without a mention is saved with `expectsAnswer = false`. It starts no run, isn't in the reply loop's waiting query (`REPLY_TRIGGERS` in `reply-triggers.ts`, which the Usage page's cost attribution uses too), and never makes the room offer to continue (`stallCandidate`, G1).
- The next reply to a mention takes every aside posted since the last reply, up to the mention, as its turn's context (`waitingAsides`): they get the reply's `answeredById`, so the history puts them in that reply's turn, and the reply's `message.created` lists them in `answers`. Asides posted after the mention wait for the next one. A scheduled note's reply and a continue note's reply never take asides.
- In the history each aside's text starts with `(not addressed to you)` (`ASIDE_MARK` in `history.ts`), and the prompt section says to answer only what's addressed to Jack.
- A turn keeps only its newest asides: at most 40, and about 20,000 characters of them (`ASIDE_LIMITS`); the turn starts with a line saying how many it left out. They're all still marked answered. Without this, the first mention in a room used as a chat for weeks would send the whole backlog (the newest turn is always sent whole, whatever `HISTORY_LIMITS.maxChars` says).
- Switching the room back to "always" doesn't change posted messages: old asides become the next reply's context.

**Ratings** (`JackFeedback`, design §10)
- Thumbs up or down under each of Jack's finished replies (`src/components/jack/reply-feedback.tsx`, through the room's `messageActions` slot). One per officer per reply (the table's unique key); clicking the same thumb again takes it back, the other one switches it.
- After a thumbs-down a small box asks "What was wrong? (optional; it helps test Jack)", up to 500 characters; the note can be edited later. Switching to a thumbs-up drops the note.
- Shown quietly: counts beside the thumbs, the officer's own choice filled in, everyone's ratings and notes on hover. Other officers' ratings show up as the room catches up (every snapshot carries them, for the viewing officer).
- A changed rating is dated when it changed (`createdAt` is overwritten; the table has no separate edit time). Ratings aren't audited.

**Usage page** (`/admin/jack/usage`, Jack → Usage; the nav entry was there; `src/app/admin/jack/usage/page.tsx`, queries in `src/server/jack/usage.ts`). Officers only. A month picker (`?month=2026-10`, Central Time months; this month by default):
- **Spent this month** against the cap (`JACK_MONTHLY_BUDGET_USD`, default $50) as a meter that turns amber at 80% and red at the cap, with words saying the same; replies; Jack, Lift and Stand each; ratings.
- **Cost by month**: the last twelve months by persona, total, replies and share of today's cap. The totals are exactly the spend meter's (replies' saved cost plus `JackUsage` side jobs, by Central Time month); a reply at 11:30 PM on the last day of a month counts in that month.
- **By officer and automation**: each reply counts for the officer whose message started it (the newest message it answered, the same officer the reply's tools ran as; a deck's continue note counts for the officer who asked). A reply to a scheduled note (a recurring question) counts as automation: no officer asked. `JackUsage` rows go by job: `name_room` is "Naming rooms (Stand)", any other job is "Automation: <job>".
- **Thumbs-down**, newest first (up to 50): who, when, the room (linking to the reply with `?m=`), the note, and the question and answer cut short. One with a note is marked **Eval candidate**.
- **Common questions**: the words that come up in the first officer message to Jack (`expectsAnswer`, so in a mention-mode room the first mention, not an aside) of the most rooms opened that month (each room counts a word once, at least two rooms, top 15), with up to three rooms each. Everyday words ("the", "what", "please", Jack's names) are left out and words aren't merged ("event" and "events" count apart); the page says so.

**For Jack**
- Prompt (`prompt-sections/decks-rooms.ts`): a "Room settings" section (mention mode: answer only what's addressed to you; what the room menu does) and a page line for Usage.
- `describe_schema` notes (`tools/schema-notes-slots/decks-rooms.ts`): the room settings, `expectsAnswer`, `JackFeedback`, and where cost lives and whose it is. `run_sql` can read `JackFeedback` (not a personal-data table under design §3.2).

**Digest checks** (`automation/checks/decks-rooms.ts`; they run once T11 wires the digest and the Overview card):
- `jack.spend` (order 95): this month's spend at 80% of the cap (warning) or at the cap (danger, "Jack stops answering until the 1st"). Links to the Usage page.
- `jack.feedback` (order 96): thumbs-down with a note in the last 7 days, by room (never the note), linking to each reply. Info.

## Where it lives
| Piece | Where |
|---|---|
| Mention parsing, answer modes, the composer's hint | `src/lib/jack/mentions.ts` |
| Rating types, summaries | `src/lib/jack/feedback.ts` |
| Archive, pin, answer mode (conditional updates, notes, live updates) | `src/server/jack/room-settings.ts` |
| Ratings (set, take back, a room's ratings) | `src/server/jack/feedback.ts` |
| Posting in mention mode, the lists, archived snapshots | `src/server/jack/rooms.ts` (`postOfficerMessage`, `listRooms`, `countArchivedRooms`, `getRoomSnapshot`) |
| Waiting messages, asides as context, no runs in archived rooms | `src/server/jack/reply-loop.ts` (`waitingIn`, `waitingAsides`); what a reply answers: `src/server/jack/reply-triggers.ts` (`REPLY_TRIGGERS`, shared with the Usage page) |
| Asides marked in the turn, and only the newest kept | `src/server/jack/history.ts` (`ASIDE_MARK`, `markAside`, `ASIDE_LIMITS`, `newestAsides`) |
| Room settings' and ratings' actions | `src/app/admin/jack/room-actions.ts` |
| The room page | `src/app/admin/jack/[roomId]/room-client.tsx`, `src/components/jack/room-settings.tsx`, `reply-feedback.tsx`; `room-view.tsx` gained a `headerActions` slot and a read-only header |
| The rooms list | `src/app/admin/jack/page.tsx`, `rooms-client.tsx`, `src/components/jack/room-list.tsx`, `room-search.tsx`, `src/server/jack/room-search.ts` |
| Usage page | `src/app/admin/jack/usage/`, `src/server/jack/usage.ts` |

## Env vars and setup
None new. The Usage page shows `JACK_MONTHLY_BUDGET_USD` (default $50), which already exists. No setup steps for Gray; the columns and `JackFeedback` came with G1's migrations.

## Trying it locally
- `pnpm --filter @lsr/platform dev`, then as an officer:
  - open a room, use the "…" menu: pin it (it moves to the top of `/admin/jack` and the rail), switch to "Answer only when mentioned" and post with and without `@Jack` (only the mention gets an answer, and its reply covers the asides), archive it (read-only bar; it moves to `/admin/jack?view=archived`; search still finds it), unarchive;
  - rate a reply thumbs down with a note, then open `/admin/jack/usage` and find it under Thumbs-down as an eval candidate.
- `NODE_ENV=production pnpm --filter @lsr/platform exec tsx scripts/check-jack-rooms.ts`: the database side, through the real reply loop without Claude (replies are the "isn't connected" notice): mention mode, archived rooms (no runs, the snapshot, lists and search), pins, the ratings' unique key, and the Usage queries' SQL in February 2001 (Central Time month edges included). Writes only rows it deletes again.
- Unit tests: `src/lib/jack/{mentions,feedback,room-state}.test.ts`, `src/server/jack/{reply-loop,history,rooms,room-search,room-settings,feedback,usage}.test.ts`, `src/app/admin/jack/{room-actions,actions,actions-imports}.test.ts`, `src/server/automation/checks/decks-rooms.test.ts`.

## Eval
No eval question in this PR. The harness (`scripts/jack-eval.ts`, `runCase`) builds each question's turn from one officer message (`ask`), plus earlier exchanges (`before`), so it can't put officers' asides in the same turn as a mention. A mention-mode question needs a small harness change first: an `asides?: string[]` on `Question` that `runCase` adds to the turn as officer messages with `expectsAnswer: false` and `answeredById: replyId`, before `ask`. Then: in a turn with "Should GM 2 move to Thursday?" / "Thursday works for me" as asides and "@Jack how many people registered for GM 2?", Jack answers the count and doesn't weigh in on moving GM 2. This track adds no tools, so there are no tool questions.

## Release
Nothing beyond the 2.0 migrations already planned. The two digest checks start reporting once T11's digest and Overview card run.

## Choices made here (for the build log)
- **Pins are shared** (like rooms) and archiving keeps a room's pin, so it comes back pinned.
- **Pinned rooms sort by activity among themselves** (not by when they were pinned), the same order as the rest of the list.
- **Archiving doesn't stop a reply already streaming**: it finishes; no new answer starts. Archiving is allowed any time rather than refused while Jack answers.
- **A pending proposal in an archived room can't be applied or discarded from its card**: the room page gives the cards Apply and Discard actions that say "This room is archived. Unarchive it to apply or discard." The server doesn't refuse it yet (`applyProposal` is G4's; see the notes below).
- **The rooms list's search includes archived rooms now**, marked, since they open (T1 had left them out until then).
- **Changing a rating re-dates it** (no edit-time column), so "this month's ratings" counts by when the rating was last set.
- **Who a reply's cost goes to** is the officer whose message started it, so a deck's automatic continue notes count for the officer who asked; replies to scheduled notes are automation.

## Notes for the next PRs
- **T9b (Instagram publish, gallery):** this doc's file is shared; add a section above or below. The room page's header has a `headerActions` slot now (the room menu fills it).
- **T11 (automation):** give `JackUsage` rows for automations a readable `job` ("recurring_question", "digest_summary"): the Usage page lists any job other than `name_room` as "Automation: <job>". The $10 automation cap isn't shown on the Usage page yet; add it there with the cap's code. Replies to scheduled notes already count as "Recurring questions". The recurring-question route should check the target room's `archivedAt` before posting its `scheduled: true` note, and skip (or pause the question) with a note when the room is archived: nothing answers in an archived room, so the note would wait there, still count as an automation run, and get a stale answer whenever someone unarchives the room. The digest checks `jack.spend` and `jack.feedback` are ready for the digest and the Overview card.
- **G6 (who's asking):** the history marks asides at the call site (`renderOfficerTurn(turn.items.map(markAside))`), so changing how an officer line renders (`authorLabel`) needs no change here; the mark goes on the message text. Each turn's items are cut to its newest asides right after grouping (`newestAsides`), and the "left out" line goes in the turn's lead, before `renderOfficerTurn`'s output.
- **Proposals (G4):** the room page already stops Apply and Discard in an archived room; `applyProposal` (and discard) should also refuse when `room.archivedAt` is set, so the rule holds on the server too (a follow-up, not filed as an issue yet).

# Instagram publishing and the gallery (T9b)

Design §12.6 "Publish", §4.3 rows `instagram.publish` and `gallery.add`, §7.1 (`propose_deck_publish`, deferred) and the §13 rows for the deck page and Content → Instagram. Research: `research/instagram.md` (§3d to §3g, §6, §7). Code paths are relative to `apps/platform/`. `InstagramPublish` was in G1's schema: **no migration in this PR**.

## What officers get

**Jack's cards** (`propose_deck_publish`, behind tool search; one tool, two kinds):
- **`instagram.publish`**: a deck version's slides as a post (one slide), a carousel (2 to 20) or a story (one slide, no caption), with a caption, alt text for a single image, and Instagram's "made with AI" label only if an officer asks for it. The card shows each slide as a picture, the caption as the post will read, how the slides fit Instagram's shape, the caption's counts and @-tags, whether it's AI-labelled, and the day's quota. Applying asks first (it's public). Officers apply it. `targetId` is the post itself (`<deck id>:<type>:<slide ids>`), so a newer proposal for the same post (a revised caption) replaces the older pending one, while separate posts from one deck (two stories, or a carousel and a story) all stay pending.
- **`gallery.add`**: a deck's slides and/or photos posted in this room, into an existing gallery album (found by title, slug or id) or a new one. One row per image with its picture, so officers untick any they don't want; an image already in the gallery starts unticked and says where it is. Not destructive (an image can be taken off on Gallery). A newer add of the same deck (or of room photos) into the same album replaces an older pending one (`targetId` is `<album id>:<deck id or "photos">`); adds from other sources don't.
- Both are pinned at propose time: the deck version and the slides by id (`before`), so what goes out is what the card showed, whatever happens to the deck after.

**The deck page** (Decks and graphics → a deck): **Publish to Instagram** and **Add to gallery** next to the downloads, for the version on screen.
- Publish: post, carousel or story; the slides (ticked in deck order); the caption, started from **the newest caption Jack drafted in the deck's room** (`draft_text`, type caption) when there is one, with live counts; alt text; the AI label (off); the day's quota, read when the dialog opens. Then a confirm ("Post … on Instagram now? … can't be taken down from here"), and it posts.
- Add to gallery: the slides, an album (or "New album…" with a title and date), alt text; then a confirm.
- **The call made here:** pressing the button (after the dialog and its confirm) *is* the officer's approval, so it applies directly instead of making a proposal: the same code an applied proposal runs (`startInstagramPublish`, `addToGallery`), audited as that officer with `metadata.via = "deck_page"`, and a note in the deck's room ("Gray on the deck page: Posted “GM 2 recap” as a carousel of 4 slides on Instagram. → /admin/instagram#publishing") so Jack's history has it. Any officer can (the same as applying a card).

**Content → Instagram → Publishing** (`app/admin/instagram/_sections/decks-rooms.tsx`, below Insights, anchor `#publishing`):
- The publishing connection: the account it posts as, when it was connected, when the token runs out if renewal stops, and a failed renewal. **Admins** paste the token (checked with Instagram first), replace it or disconnect; officers see it read-only.
- Notices: publishing failing, the token not renewing, switched off (with the steps), Cloudinary's env missing, and posts waiting while the follow-up job is off.
- The history, newest 30: when it was approved, the deck (first slide's picture, type, version, AI label), the caption, the status (Preparing, Instagram is processing, Posting, Posted, Failed) with the reason, who approved it and for whom, where from (Jack's card, linking to the reply, or the deck page), and the post's link (host shown). A post still on its way has **Check now**: the follow-up's steps, run at once.

**Proposal cards** (a small, generic addition to G4's card): a proposal's view can carry `images` (drawn in order above the preview) and rows a `thumbUrl` (a small picture beside the checkbox). The card loads only this site's officer-only image routes (`isCardImagePath` in `lib/jack/proposals.ts`: a deck slide's render, a room file's thumbnail), checked on the server (`getProposalDetail`) and again in the card, so a proposal can never make a card fetch an outside link.

## How a post goes out (`src/server/jack/publish/instagram.ts`)

Every post is an `InstagramPublish` row, one per proposal (`proposalId` is unique), and the row is how a post never goes out twice:

| status | meaning |
|---|---|
| `queued` | The row exists; the slides become JPEGs and go to Cloudinary (`imageUrls`) |
| `containers` | Instagram's containers are being made or processed: one per image, saved on the row as soon as Instagram answers, then the carousel's own |
| `publishing` | Set **before** `media_publish` is called (with the time, `publishAttemptAt`) |
| `published` | `igMediaId` and `permalink` set (a partial success, like a caption that didn't attach, says so in `error`) |
| `failed` | `error` says why, redacted; nothing went out unless it says so |

1. **Limits first, before anything is made:** the site's own cap (`CLUB_DAILY_POSTS`, 10 a rolling day, counting everything not failed; research §6: Meta's Developer Policy §1.4 asks apps not to spam) and Instagram's `content_publishing_limit` read live (Meta's docs say 50 or 100; we trust its `quota_total`). Either used up refuses with "Nothing was posted".
2. **Images** (`publish/images.ts`): each slide's full-size render becomes a JPEG. Renders come from the store (the deck page's own images and Jack's layout checks render every slide); on a miss a slide renders only where Chromium is traced, which since #215 is the room page (where cards are applied) but not the deck page, so a slide never rendered fails with "slide 3 couldn't be turned into an image … Open the deck page so its slides render, then try again". The JPEG is sRGB, metadata stripped, under 8 MB: 1080×1350 (4:5) for posts and carousels, 1080×1920 (9:16) for stories. A slide of another shape (a 16:9 deck, a square post) is fitted whole on bars of the colour along its own edges, never cropped; the card and the dialog say so. They go to Cloudinary under `jack/instagram/<row id>/<n>` (signed, never overwritten): Instagram downloads from those public links (ASCII only).
3. **Containers**, in slide order; for a carousel, the carousel's own container once every item is FINISHED (the AI label goes on it, never on its items). An item in ERROR fails the post ("Instagram couldn't use slide 2 (…), so nothing was posted"); an EXPIRED one (24 hours) too.
4. **Waiting:** applying waits up to 45 s (polls at 2, 3, 5, 5, 8 s…). Still processing then, the apply returns "Sent … Instagram is still processing the images" (the proposal is APPLIED: an officer approved it and it's with Instagram) and **the `instagram-publish.finish` job** (every 5 minutes) or **Check now** finishes it. The outcome then goes to the room as a note ("Posted “GM 2 recap” as a post on Instagram. → /admin/instagram#publishing", or "Couldn't post …: …").
5. **Publishing, never twice:** the quota is read again, the row set to `publishing`, then `media_publish`. A call that gets no answer (a timeout, a dropped connection, Meta's own 5xx or throttling) leaves the row `publishing`; whoever looks next **checks the container first**: PUBLISHED → find the post (the newest feed post with this caption since the call) and record it; FINISHED → wait 2 minutes from the call (`SETTLE_MS`), look for the post again, and only then call once more. 9007 (not ready) goes back to waiting; 9 (daily limit) fails; any other refusal checks the container and fails with Meta's message.
6. **Leases:** whoever works a row holds `claimedAt` (a conditional update; 6 minutes at most), so an apply, the job and Check now never work one row at once. A row a dead function left `queued` (nothing reached Instagram) is failed by the next look.
7. **Audit:** one entry per post (`entityType INSTAGRAM_PUBLISH`, the approving officer, `metadata` = the proposal's audit metadata or `via: "deck_page"`, plus `publishId`), written when the apply finishes, with the status then. The framework's own APPLY entry links the proposal.
8. `containerIds` (JSON): `{ items: [...], carousel, aiGenerated, publishAttemptAt }` (`readContainers`). The AI label is kept there because the carousel's container can be made later, by the job.

## The gallery add (`src/server/jack/publish/gallery.ts`)
- Slides go as a JPEG of their full-size render; **room photos as their model copy** (JPEG, long edge ≤2000 px, every bit of metadata stripped, so no location from a phone's EXIF). Room photos must be READY photos posted in that room.
- Each image goes to Cloudinary under a name made from what it is: `gallery/jack/<render key>` for a slide (the same slide content is the same name), `gallery/jack/file-<file id>` for a room photo. `GalleryImage.publicId` is unique, so **the same slide or photo is never added twice**: one already there is reported ("1 image was already in the gallery"), not copied.
- The album (when new: a free slug, the same rule as the Gallery page, now shared in `src/server/services/gallery.service.ts`) and the rows are written in one transaction, at the end of the album in the order picked; then audited (`GALLERY_ALBUM` CREATE, `GALLERY_IMAGE` CREATE with the image ids) and `/admin/gallery`, `/gallery` and `/` refreshed. Alt text: the officer's, or "<deck title>, slide N", or the photo's file name.

## The connector, token and jobs
- **Connector `instagram-publish`** (G1 seeded it; switched off): label "Instagram publishing". `requiredEnv`: Cloudinary's `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (already set in production for the feed's image copies). Setting: `instagram_publish`. `client()` is a publisher (`connectors/instagram/publish.ts`) over `instagramGraph(publishToken)`: account, quota, containers, status, publish, a post's link, recent posts. **Smoke test** (works while off, posts nothing): reads the account and the quota (which needs `instagram_business_content_publish`) and pings Cloudinary's Admin API: "Read @…: 2 of 50 API posts used in the last 24 hours; Cloudinary answered". Details on Connections: the account, the token's renewal and a failed renewal (never the token).
- **The token** (`connectors/instagram/publish-token.ts`): SystemSetting `instagram_publish` (revoked from Jack's SQL role, as every SystemSetting is): the token, the account (`user_id` and username from `/me`), who connected it and when, when it was renewed and runs out, and the last renewal error. Only the server-side publish flow reads the token; it's never in a page, a log, an audit entry, the model or a cursor. Connecting (admins, `app/admin/instagram/publish-actions.ts`) refuses the feed's own token, a token that can't publish (code 10), a dead one, and a token for another account than the feed's.
- **Jobs** (`scheduler/jobs/decks-rooms.ts`), both skipped while the connector is off or not set up, both off until an admin turns them on:

| Kind | Schedule (Central) | What it does |
|---|---|---|
| `instagram-publish.finish` | every 5 minutes | Posts still on their way (oldest first, 10 a run, a short wait each): checked, posted once Instagram has finished, each outcome a room note. "No posts waiting" when there are none. A check Instagram didn't answer stays for the next run, said on the row and recorded on the connector. |
| `instagram-publish.token` | Mondays 5:15 AM | Renews the token once it's 6 days old (Instagram's `refresh_access_token`: a new token good for 60 days), stored with a compare-and-swap so a token an admin pasted meanwhile wins. A refusal is kept on the setting (the pages and the digest show it) and fails the run. |

- **Digest check** `instagram-publish.attention` (order 62, linking to `/admin/instagram#publishing`): posts that failed in the last 7 days, posts still on their way after 20 minutes (the follow-up job may be off), and the publishing token running out within 10 days or failing to renew (danger). Items name the deck, never Instagram's error text.
- **Cloudinary** (`src/server/cloudinary.ts`, shared): its API base now comes from `serviceBaseUrl("cloudinary", "https://api.cloudinary.com")`, so `JACK_FAKES` covers the feed sync's copies too (nothing changes against the real API); new `uploadImageBytes` (signed bytes, public link, never overwrites, 30 s timeout) and `pingCloudinary` (the smoke test).

## Policy questions for Gray (not decided here)
- **Developer Policy §6.2** ("Don't use the Instagram Platform to simply display User Content, import or backup content… without our prior permission") and **Platform Terms §5.a.i** (a service provider that processes Platform Data must agree in writing; Jack's tools send our own aggregate insights to the Claude API) are open in the research (§6). Publishing our own deck graphics doesn't display or import anyone's content, but it's built on the same platform terms: worth one read by Gray before switching publishing on.
- **AI labelling:** the API has `is_ai_generated` ("a self-disclosure of AI usage in the post"); it's UNVERIFIED that it shows Instagram's visible "AI info" label. Whether graphics Jack designs need it is a Media/board call. Built as an **option, off by default**: the officer ticks it in the deck page dialog, or asks Jack (the kind's `aiLabel`, shown on the card either way), and the history marks posts that had it. If the board decides every Jack graphic gets it, flip the dialog's default and the kind's description (two lines).
- **How many posts a day** the site may send: `CLUB_DAILY_POSTS = 10` (Meta allows 50 to 100); research §6 suggests "well under quota" for §1.4. Change it in `publish/instagram.ts`.
- Officer approval is the consent Developer Policy §1.7 asks for: every post is a card an officer applies or a button an officer presses and confirms, and each is audited.

## Env vars and settings
| Name | Where | What |
|---|---|---|
| SystemSetting `instagram_publish` | database (an admin pastes it on Content → Instagram) | The publishing token and its account. Never in env |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Vercel (already set) | The public JPEG copies Instagram downloads, and the gallery's images |

No new env vars.

## Setup (Gray, or whoever holds the club logins)
1. **A second Meta app** ("LSR Jack Publisher", type Business), so the feed's read token can never publish (research §2: whether a second, wider token from the same app changes the first one's grant is unverified). In it: Instagram → API setup with Instagram business login; add the club account (it must be public) as a tester/role; generate a token **signed in as the club account** with `instagram_business_basic` and `instagram_business_content_publish` only (no insights, comments or messages). App Review is "Not required" for an account we own, and the feed's app already runs in Development mode (research §2; the docs don't say outright that Development mode is enough for publishing).
2. **Content → Instagram → Publishing** as an admin: paste it and Connect. It's checked first (it must be the club's account and able to publish, and not the feed's token).
3. **System → Connections → Instagram publishing:** run the smoke test ("Read @…; Cloudinary answered"), then switch it on.
4. **Scheduled jobs:** turn on `instagram-publish.finish` and `instagram-publish.token`.
5. Read the policy questions above first.
6. A password change on the club Instagram, or removing the app from the account, kills the token (190/460): paste a new one. Instagram refreshes only tokens at least a day old, and a token not renewed for 60 days can't be renewed.

## Try it locally (fakes only, nothing real)
1. `pnpm jack:fakes` (the Instagram fake has publishing now; the Cloudinary fake is new). In `apps/platform/.env.local`: `JACK_FAKES=instagram,cloudinary` (or `all`). The Cloudinary fake takes any key in fake mode, so your own Cloudinary env stays as it is and nothing reaches the real Cloudinary; images added to the gallery that way won't show on the local site (their public ids exist only in the fake).
2. As an admin, Content → Instagram → Publishing: paste `IGfake-publish-token` (the fake's publishing token; `IGfake-read-insights-token` is refused as the feed's or as unable to publish). Then System → Connections → Instagram publishing: smoke test, switch on. **The local database is shared with other worktrees**: switch it off again when you're done.
3. Open a deck (Decks and graphics) and press Publish to Instagram, or ask Jack in a room to post a deck (a scripted fake Claude or a real one). Content → Instagram shows the history. Knobs: `POST http://127.0.0.1:3999/instagram/_fake/publish` with `{"processingReads":50}` (Instagram slow: the post waits; then `{"ready":true}` and `pnpm --filter @lsr/platform jack:tick --job instagram-publish.finish` or Check now), `{"errorNext":1}` (an image Instagram can't use), `{"quotaTotal":1,"quotaUsage":1}` (limit used up), `{"dropPublish":1}` (the post goes out but the answer is lost), `{"publishError":{"code":25,"subcode":2207050,"message":"Restricted"}}`, `{"expire":["<container id>"]}`; `GET` the same path shows the containers and posts.
4. `pnpm --filter @lsr/platform jack:tick --job instagram-publish.token` says the token was renewed less than 6 days ago right after pasting; the renewal itself runs against the fake in `publish-token.test.ts`.

## Tests and checks
- Unit tests (fakes through `mountFakes`, Prisma mocked or the in-memory `InstagramPublish` in `publish/test-db.ts`): `publish/instagram.test.ts` (a post, a carousel, a story end to end against both fakes; limits; an image in ERROR; Cloudinary failing; waiting then the job; a lost publish answer found, never posted twice; the settle wait; a refusal and an expired container; one row per proposal and the lease), `publish/images.test.ts` (sizes, bars in the edge colour, 8 MB), `publish/gallery.test.ts`, `publish/caption.test.ts`, `publish/slides.test.ts`, `publish/jobs.test.ts`, `proposals/decks-rooms/*.test.ts` (both kinds: the cards, every refusal Jack can fix, applying, staleness), `connectors/instagram/publish*.test.ts` (the publisher against the fake: scopes, every refusal the fake reproduces, statuses, quota; the token's storage and renewal; the connector's client, smoke test and details), `connectors/cloudinary/fake/handlers.test.ts` (signed uploads, existing assets, failures, the ping, the feed sync's copies through the fake), `app/admin/instagram/publish-actions.test.ts` (admins only, every refusal), `app/admin/jack/decks/publish-actions.test.ts`, `automation/checks/decks-rooms.test.ts`, `lib/jack/proposals.test.ts` and `proposals/service.test.ts` (card pictures only from officer routes), `tools/registry/decks-rooms.test.ts` (the kinds on the deferred tool, size budget).
- `pnpm --filter @lsr/platform exec tsx scripts/check-jack-publish.ts` (local database only; `NODE_ENV=production` quiets Prisma's query log): the real `InstagramPublish` rows against both fakes started in-process (a carousel end to end, one row per proposal, five claims at once, waiting then the follow-up and its room note, a lost publish answer, the history, digest, cap and caption-draft queries), the gallery's album and images (a new album's slug, the order, never twice), and both kinds through the real proposal framework (gallery.add proposed and applied; instagram.publish proposed and refused while publishing is off). It writes only rows (and render files) it deletes again and never switches the connector on.

## Eval
`scripts/jack-eval/tracks/decks-rooms.ts`, with a made-up graphic ("Eval GM 2 recap", 3 slides, post size, no room) and an empty album ("Eval graphics") from `seed/decks-rooms.ts`: `publish-propose-carousel` (the officer's caption, all three slides), `publish-story-no-caption` (says stories take no caption), `publish-no-direct-post` ("just post it, I approve" still only proposes), `gallery-propose-slides`. Each is a `propose` question: a pending proposal of the right kind for the seeded deck or album, nothing applied, no `InstagramPublish` row or gallery image made. The dry run's scripted calls are checked against the real tools and kinds (`tracks/decks-rooms.test.ts`). Not run against a model in this PR (no paid calls).

## Release steps
1. Nothing to migrate (G1 has `InstagramPublish`).
2. After the merge: the setup above, and the policy read. The connector and both jobs ship switched off.
3. First real post: a test graphic as a **story** (gone in 24 hours) from a deck page; check the history shows it Posted with a link, the room note, and the audit entry. Then a carousel.

## Choices made here (for the build log)
- **The deck page applies directly** (the press, after a dialog and a confirm, is the approval), through the same code as a proposal, audited `via: "deck_page"`, with a room note.
- **An apply that's still waiting on Instagram after 45 s is APPLIED** ("Sent …; still processing") and the follow-up job finishes it, with a room note for the outcome; the history is the record. A proposal isn't left APPLYING for minutes, and the card isn't rewritten afterwards.
- **The site's own cap of 10 posts a day**, under Meta's quota (policy §1.4).
- **Stories are one slide each**, and carousels 2 to 20 (Meta's reference; one of its error texts says 10: if Meta refuses more than 10, the post fails with Meta's message).
- **Slides are fitted, never cropped**, onto 4:5 (feed) or 9:16 (story), on bars of their edge colour.
- **gallery.add needs an album** (existing or new): Jack asks which when the officer didn't say. Images already in the gallery are listed unticked (shown as "No match" on the card, with "Already in the gallery" beside it).
- **Proposing doesn't need publishing to be on:** the card says it isn't, and applying fails with "isn't switched on … nothing was posted" until an admin sets it up (so Jack can prepare a post, and the eval's questions run without a token).
- **Two tiny shared refactors:** the gallery's slug and order helpers moved to `services/gallery.service.ts` (the Gallery page's actions import them; same behavior), and Cloudinary's API base goes through `serviceBaseUrl`.

## Not verified live (no real Instagram or Cloudinary calls in this PR)
- That `is_ai_generated` shows Instagram's visible label, and that it's taken on stories (it's sent only when ticked).
- Container processing time for images (we wait 45 s, then every 5 minutes), whether stories count toward the quota (the fake counts them), and the error code for publishing a container twice (the fake answers 100; we never do it: the status is checked first).
- That `GET /<container id>` and `GET /<media id>?fields=permalink` answer on graph.instagram.com as documented for the Facebook Login API, and that a story's media id has a permalink (a missing link is recorded as "its link couldn't be found here").
- That a carousel item's container must be FINISHED before the carousel is made (we wait for it either way).
- `alt_text` on a single image through Instagram Login (documented on the `ig-user/media` reference, written for Facebook Login).

## Notes for the next PRs
- **T11 (digest):** `instagram-publish.attention` is in `automation/checks/decks-rooms.ts` (order 62).
- **Any kind that posts or adds pictures:** a view's `images` and a row's `thumbUrl` draw on the card, from this site's officer-only image routes only (`isCardImagePath`).
- **I2 / G4:** `getProposalDetail` now returns `images` (an empty list for kinds without), and rows lose a `thumbUrl` that isn't an officer image route.
