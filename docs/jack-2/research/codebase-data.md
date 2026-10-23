# Codebase survey: data model and pipelines (10/22)

Read-only survey for Jack 2.0. Paths are under `apps/platform/`. Schema: `prisma/schema.prisma`.

## 1. Race data
- League → Season → Entry. RawResultUpload → RaceSession → RaceParticipant / RaceResult / RaceLap / RaceEvent. **There is no Standings model; Entry holds the standings.**
- **Season and Event have no foreign key.** A season's rounds are the events with `Event.seriesId = Season.seriesId` and `startsAtUtc` between `Season.startAt` and `Season.endAt`. `Event.roundNumber Int?` exists.
- **League**: slug, name, descriptionMd, visibility.
- **Season**: leagueId?, seriesId?, name, slug (unique), year, startAt?, endAt?, pointsRule Json?, visibility.
- **Entry** (unique `[seasonId, userId]`): totalPoints, totalCuts, totalCollisions, totalPositionsGained, starts, wins, podiums, top5, top10, bestFinish?, averageFinish Float?, dnfs, rank?, carDisplay?. `number` and `isEligiblePoints` are never used.
- **RawResultUpload**:
  - filename, sha256, `rawJson` (the whole Assetto Corsa file), status UPLOADED/PARSED/INGESTED/FAILED
  - eventId?, pointsSystem (F1 / HALF / NONE), sessionLabel, uploadedByUserId
  - ParseReport: drivers Json, resultsCount, lapsCount, anomalies[].
- **RaceSession**: uploadId, eventId?, sessionType (RACE / QUALIFYING / PRACTICE), trackName, trackConfig?, startedAt, pointsSystem.
- **RaceParticipant** (unique `[sessionId, driverGuid]`): driverGuid, displayName, carName, carClass, teamName?, carIdInSession, nation, skin, ballastKg, restrictor, userId? (copied from DriverIdentity at ingest), carMappingId?.
- **RaceResult**:
  - position (the index in the JSON Result array); classPosition is **always 0**
  - bestLapTime and totalTime in ms; gap as a string
  - lapsCompleted and totalCuts (sum of lap cuts), collisionCount (from Events)
  - penaltyTime, lapPenalty, isDisqualified
  - points (RACE only; F1 = 25/18/15/12/10/8/6/4/2/1, HALF = halved, NONE = 0)
  - **status is only "FINISHED" or "DSQ"; DNF is never written, so `Entry.dnfs` is always 0.**
- **RaceLap** (every session type): lapNumber (per driver, sorted by Timestamp), lapTime ms, sector1/2/3 ms, cuts, valid (cuts === 0), tyre, timestamp. **No per-lap position.**
- **RaceEvent**: type (COLLISION_WITH_CAR / COLLISION_WITH_ENV), carId, driverGuid, participantId, other* fields, impactSpeed, world and relative x/y/z.
- **DriverIdentity**: driverGuid (unique), lastSeenName, userId?. Upserted when an upload is parsed (`parseUpload` in `src/app/admin/results/actions.ts`); linked in `src/app/admin/drivers/actions.ts`, which back-fills `RaceParticipant.userId`.
- **CarMapping**: gameCarName (unique), displayName, secondaryDisplayName (`src/app/admin/cars/actions.ts`; creating one back-links participants).
- **Import:** `ingestUpload` in `src/app/admin/results/actions.ts` (around lines 274–603).
- **Standings:** `recomputeStandings` in `src/app/admin/seasons/actions.ts` (lines 127–322).
  - Only RACE sessions count; QUALIFYING positions are used only for positionsGained.
  - Drivers with no userId are skipped. Rank sorts by points with no tie-break. Old Entry rows are never deleted.
  - Writes AuditLog (entityType SEASON).
- **Reads:**
  - `src/server/repos/standings.repo.ts` `getStandings(slug)` (incidents = cuts + collisions)
  - `src/server/queries/standings.ts` `getPointsProgression`
  - `src/server/queries/results.ts`
  - `src/server/queries/driver-profile.ts`
- **Jack's `standings` tool** (`src/server/jack/tools/standings.ts`):
  - Input `{season?, league="lone-star-cup", limit=30}`.
  - Returns the season, other seasons, standingsLastRecomputed, standings rows and round statuses.
  - Exports `raceSessionsCount` and `roundResults`.
- `src/server/jack/tools/seasons.ts` is a helper, not a tool: `resolveLeagueSeason(leagueSlug, seasonSlug?)` and `DEFAULT_LEAGUE`.

## 2. Recruiting (`schema.prisma` lines 1090–1230)
- **RecruitingCycle**: slug, name, opensAt, closesAt (exclusive), isActive (at most one active), formVersion, sweptAt.
- **Application** (unique `[cycleId, userId]`):
  - state DRAFT/SUBMITTED
  - applicant snapshot: fullName, email, eid, gradYear, major
  - genericAnswers Json, resumeUrl, portfolioLinks Json `[{label, url}]`, draftStep, formVersion
  - submittedAt, autoSubmitted
- **ApplicationTrack** (unique `[applicationId, track]`): track key, answers Json, status SUBMITTED / IN_REVIEW / INTERVIEW / ACCEPTED / REJECTED, decidedAt, decidedById.
- **ApplicationReview**: applicationTrackId, reviewerId?, score Int? (1–5), notes? (≤2000). Reviews are only ever added, never edited.
- **ApplicationEmail**: a per-recipient delivery log (see section 4).
- **RecruitingTrackConfig**: `[cycleId, track]` → schedulingUrl (a Google Calendar booking link).
- **There's no interview table:** INTERVIEW is only a status.
- **Teams** are hardcoded in `src/schemas/recruiting.schema.ts` `tracks`: technology, community, media, competition, business, all with interviewRequired. Questions are in `trackQuestions`; labels in `src/lib/recruiting/labels.ts` (SUBMITTED shows as "New", REJECTED as "Not moving forward").
- **Status flow** (`src/server/services/recruiting.service.ts`):
  - A DRAFT becomes SUBMITTED when the applicant submits, or through the deadline sweep (cron `src/app/api/cron/recruiting/route.ts`, every 15 min, `autoSubmitted = true`).
  - `setTrackStatus` (lines 680–770):
    - expected-status guard;
    - INTERVIEW only for teams that interview;
    - every status except IN_REVIEW sets decidedAt/decidedById;
    - cancels pending decision emails;
    - writes AuditLog `APPLICATION_TRACK_STATUS_CHANGED`.
  - `addReview` writes `APPLICATION_REVIEW_ADDED`; viewing writes `APPLICATION_VIEWED`. Officers can't review or decide their own application.
  - Applicant side is gated by FeatureFlag `recruiting` (`src/lib/recruiting/flags.ts`).
- **RLS:** on for all six recruiting tables, with a `jack_readonly_select` policy on each. **This is the only RLS in the schema.**
- **Privacy gap for a Jack tool:** the app hides DRAFT applications and an officer's own reviews (`viewerId` logic in `src/server/repos/application.repo.ts`), but jack_readonly sees everything. **A recruiting tool must filter `state = 'SUBMITTED'` and drop reviews where `Application.userId = actor.userId`.**
- **Admin pages** (`src/app/admin/recruiting/page.tsx`, `src/components/admin/recruiting/recruiting-console.tsx`):
  - `countSubmittedTracks` (groupBy track, status)
  - `listSubmittedTracks` (reviewCount, averageScore; filters)
  - a count of unsubmitted drafts
  - `countEmailsNeedingAttention`
  - `listCycles` in `src/server/services/recruiting-cycle.service.ts`
  - "Unreviewed" isn't defined anywhere; the closest are SUBMITTED ("New") or reviewCount = 0.

## 3. Content for site search
- **Post**: title, slug, excerpt?, bodyMd, coverImageUrl?, publishedAt?, visibility, authorId. Published = `publishedAt <= now` and public (`src/lib/news.ts`). Tags come through `Tag` + `EntityTag` (entityType 'post').
- **Page**: title, slug, bodyMd, visibility (e.g. `lone-star-cup-rules`, `src/lib/page-slugs.ts`).
- **Event**: title, slug, summary?, description?, heroImageUrl, meetingUrl, streamUrl. Plus EventSeries.title, Venue (name, address, city, room), League.descriptionMd, Season.name.
- **Gallery and Instagram:** GalleryAlbum (title, slug, description?, date?, eventId?), GalleryImage (alt, creditName, creditUrl), InstagramPost (caption, permalink, mediaType, postedAt, hidden).
- **Not in a readable table:**
  - The /about officer roster is hardcoded in `src/app/about/roster.ts`.
  - The homepage hotlap/clip settings are in SystemSetting, which Jack can't read.
- **Search support today:**
  - No full-text or trigram indexes; no tsvector or pg_trgm.
  - `run_sql` blocks `pg_*` functions except `pg_typeof`/`pg_size_pretty` and caps results at 200 rows.
  - Gallery search is a case-insensitive substring match (`findGalleryAssets` in `src/server/jack/decks/assets.ts`).

## 4. Notifications and email
- **Notification** is one row per recipient per channel (IN_APP / EMAIL):
  - type, title, body, actionUrl, metadata
  - status PENDING/SENT/FAILED/CANCELLED, scheduledFor, sentAt, readAt, dismissedAt
  - **emailMessageId (the Resend id)**, emailError
- **Types** (`src/server/services/notification.service.ts`): REGISTRATION_CONFIRMED, WAITLIST_PROMOTED, EVENT_REMINDER_24H, EVENT_POSTED, REGISTRATION_OPENED, RESULTS_POSTED, DUES_CONFIRMED, LEAGUE_REGISTERED, PAYMENT_WAITLISTED, CUSTOM.
- **NotificationPreference**: emailRegistration, emailWaitlistPromotion, emailEventReminder, emailEventPosted, emailResultsPosted. Marketing types also need `User.marketingOptIn`; receipts bypass preferences.
- **Sending:**
  - `sendNotification`, `sendBulkNotification` (createManyAndReturn; email sentAt stays null until Resend confirms), `deliverEmails` (writes emailMessageId / emailError / status).
  - `failInterruptedEmails` turns stuck rows FAILED after 10 min; cron `src/app/api/cron/notifications/route.ts` retries.
- **There's no broadcast or campaign id.** A bulk send is many rows with the same type, title and createdAt. The officer send writes an AuditLog row (entityType NOTIFICATION, entityId "bulk"/"multi"/"custom") with counts (`src/app/admin/notifications/actions.ts`).
- **ApplicationEmail** (recruiting mail): template RECEIVED / INTERVIEW / ACCEPTED / REJECTED, toEmail, subject, body, status, **resendMessageId**, error, sentAt, claimedAt, idempotencyKey (`src/server/services/recruiting-email.service.ts`).
- **Resend** (`src/lib/email/resend.ts`, resend ^6.9.1):
  - `sendEmail` (idempotencyKey) and `sendBatchEmails` (`resend.batch.send`, `batchValidation: "permissive"`, ≤100 per call); retries after 1 s and 3 s.
  - A global on/off switch and the from address are in SystemSetting (`src/lib/email/settings.ts`).
  - **No Resend webhook route; delivery events are never stored.**
  - The daily quota is counted locally (`getEmailUsage`, `RESEND_DAILY_LIMIT` default 100).

## 5. Payments and Stripe
- **Payment**:
  - userId, productId? (null = event fee), amountCents, currency, provider stripe/manual/other, status succeeded/pending/failed/refunded, paidAt
  - **providerRef**: the Checkout Session id `cs_…` while pending, failed or expired, **replaced by the PaymentIntent id `pi_…` once paid**
  - metadata: event fields, or product fields plus duplicateOfEntitlementId
  - **Not stored:** charge id, customer id, refund amount. Refund details are only in AuditLog `PAYMENT_REFUNDED` metadata, and a partial refund still marks the payment refunded.
- **Product**: type ANNUAL_DUES / LEAGUE_FEE / EVENT_FEE, name, leagueId, amountCents, active, metadata.
- **Entitlement**: kind lsr_member / league_access, leagueId, scope, validFrom/To, sourcePaymentId, meta (seasonSlug; manual grants `{source:"manual", grantedById, note}`).
- **UserMembership**: userId, tierId, validFrom/To.
- **Stripe client** (`src/lib/stripe.ts`): `getStripe()` is lazy, with **no pinned apiVersion** (SDK 20.4.1 → 2026-02-25.clover).
- **Calls made today:**
  - `checkout.sessions.create` (`src/server/services/payment.service.ts`)
  - `checkout.sessions.retrieve`/`.expire` (`src/server/services/checkout-sessions.ts`)
  - `webhooks.constructEvent` (`src/app/api/stripe/webhook/route.ts`; handles checkout.session.completed/async_payment_succeeded/async_payment_failed/expired, charge.refunded)
  - **No list, balance or refund calls.** `src/lib/payments.ts` `stripeDashboardUrl`.

## 6. Jack's tables
- **JackRoom**: title?, persona, createdById, createdAt, updatedAt, archivedAt, runId, runStartedAt. Index `[archivedAt, updatedAt]`.
- **JackMessage**:
  - roomId, kind, authorUserId, persona, **content**, **toolCalls** Json, status, streamSeq, answeredById, continues
  - model, tokens, costUsd, createdAt
  - Indexes `[roomId, createdAt]`, `[roomId, kind, answeredById]`, `[authorUserId]`. **No text index.**
- **toolCalls** = `JackToolPart[]` (`src/lib/jack/parts.ts`). **`forModel` is not saved**; history replays `[Tools used: name {input} → label]`.
- **JackUsage**: roomId?, persona, job, outcome, model, tokens, costUsd.
- **JackDeck / JackDeckVersion**: content Json `{css, slides:[{id, html, notes?}]}`, messageId, userId. No RLS on any Jack table.

## 7. Schema notes (`src/server/jack/tools/schema-notes.ts`)
- `JACK_SCHEMA_NOTES` is one template string: plain heading lines followed by `- ` bullets, table names in double quotes, columns bare. It goes in the system prompt, and `describe_schema` appends it.
- `TABLE_NOTES` has one line per table, covering 13 tables: User, UserMembership, Entitlement, LeagueApplication, Entry, Event, EventRegistration, EventAttendance, Payment, Product, RawResultUpload, RaceSession, AuditLog.
- **Not covered:**
  - recruiting (6 tables)
  - Notification, NotificationPreference
  - Post, Page, Tag, EntityTag
  - GalleryAlbum, GalleryImage, InstagramPost
  - ParseReport
  - RaceParticipant/RaceResult/RaceLap/RaceEvent detail
  - JackUsage/JackDeck/JackDeckVersion
  - FeatureFlag
  - EventSeries, Venue and MembershipTier, beyond passing mentions
- **Missing facts:** RaceResult.status is never DNF; classPosition is always 0; how Season links to Event.

## 8. Users and officers
- **User**: id, email, handle, displayName, avatarUrl?, bio?, iRating?, socials Json? `{instagram, twitch, youtube, website}`, officerTitle?, racingNumber? (+ style fields), marketingOptIn, status, major?, gradYear?, eid?, signedUpAt.
- **Roles:** `Role.key` via `UserRole`. officer and admin give console access; lsc_driver and collegiate_driver are badges only (`src/lib/roles.ts`).
- **Officer for access:** officer or admin role (`requireOfficer`). For the site badge, officerTitle is also enough.
- **The /about roster** (name, title, team, board seat) is hardcoded in `src/app/about/roster.ts` and synced by `scripts/sync-officer-badges.ts`. It isn't in the database.
- Public pages select users through `publicUserSelect` (`src/lib/public-user.ts`).
