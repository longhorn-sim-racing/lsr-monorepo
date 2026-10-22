# Codebase survey: admin console and reusable services (10/22)

Read-only survey for Jack 2.0. `SRC` = `apps/platform/src`.

## What matters most
- **Copy `draft_event`.** In `SRC/server/jack/tools/draft-event.ts`, `draftEvent` (L106) builds a FormData, validates it with the admin form's own `parseEventForm`, writes with Prisma, and calls `createAuditLog` with `metadata.via="jack"`. It's the only `writes: true` tool.
- **Many admin actions can't be reused as-is.**
  - They call `requireOfficer()`, which needs a live officer request.
  - `createEvent`/`updateEvent`/`updateEventStatus` call `redirect()`; `updateProfile` throws and redirects; `createPost`/`updatePost` throw on zod errors.
  - **The apply step should call services or shared parsers directly** (as `draft_event` does), or factor the logic out of the actions.
- **Nothing anywhere stores a pending change to apply later.**

## 1. Admin console
- **Nav:** `SRC/components/admin/shell/admin-nav.ts`. `ADMIN_NAV: AdminNavGroup[]` (L15) holds `{title, href, keywords?}`; `findNavItem` (L76) does the longest match.
  - **Groups:**
    - (none): Overview, Jack, Decks and graphics
    - Events: Events, Series, Venues
    - Racing: Seasons, Results, Hotlap and clips, Driver mapping, Car mapping
    - Members: Members and roles, Recruiting
    - Money: Payments, Products, LSC entries
    - Content: News, Pages, Gallery, Instagram
    - System: Notifications, Audit log, Tools
  - Read by `admin-sidebar.tsx`, `admin-command-menu.tsx` (Ctrl K) and `admin-shell.tsx` (top bar, breadcrumbs, `ConfirmProvider`, theme cookie `lsr-admin-theme`). `/admin/kit` is the live kit gallery.
- **Layout and guards:**
  - `SRC/app/admin/layout.tsx` calls `requireOfficerPage()`, sets force-dynamic, and uses the title template `"%s | LSR Admin"`.
  - Guards in `SRC/server/auth/guards.ts`: requireUser L21, requireRole L31, requireOfficer L47 (throws), requireOfficerPage L56 (redirects to /403), isViewerOfficer L68.
- **UI kit** (`SRC/components/admin/kit/index.ts`):
  - Buttons: `Button` (`pending`), `IconButton`
  - Badges: `Badge`, `ToneText` (tones: neutral/success/warning/danger/info/accent)
  - Surfaces: `PageHeader`, `Panel` (+Header/Body/Footer), `SplitLayout`, `Stat`, `StatRow`, `EmptyState`, `Pager`
  - Forms: `Input`, `Textarea`, `Select`, `MoneyInput`, `Field`, `FieldGrid`, `FormSection`, `CheckboxField`, `SwitchField`, `FormActions`
  - Filters: `SearchInput`, `Segmented`, `FilterMenu`, `Toolbar`
  - Tables: `Table`/`THead`/`TH`/`TR`/`TD`/`CellStack`/`TableFooter`, `DataTable<T>` with `Column<T>`
  - Row actions: `RowMenu` (destructive confirm), `RowActions`
  - Dialogs: `Dialog`, `Sheet`, `ConfirmProvider`, `useConfirm`, `usePrompt`
  - Misc: `Tabs*`, `Notice`, `JsonView` (useful for before/after), `DetailList`
  - People: `UserPicker`/`UserMultiPicker` (`searchUsersForAdmin` in `SRC/server/actions/admin-user-search.ts:19`)
  - `SRC/components/admin/use-form-action.ts:11` `useFormAction`.
- **Page pattern:** `metadata = {title}`, `await requireOfficerPage()`, load in the Server Component, then `<PageHeader/>` plus a client console (e.g. `SRC/components/admin/events-console.tsx`). Server-paginated lists keep filters in the URL. Rules are in `docs/admin-ui.md`: toasts, never `window.confirm`, Central time, works at 390px.
- **Overview:** `SRC/app/admin/page.tsx`.
  - `SRC/app/admin/_overview/get-overview.ts` `getOverview(now)` (L13) is one `Promise.all` of counts.
  - `SRC/app/admin/_overview/overview-list.tsx`: `OverviewPanel` (L19), `StatLink` (L78).
  - Tiles: results missing (90 days), draft events, events in the next 7 days, LSC applications (7 days), payments (7 days).
  - Panels: Results missing, Coming up, Draft events, LSC applications, Payments, Recent activity.

## 2. Server Actions
- `SRC/lib/action-result.ts`: `ActionResult<T=void>` = `{ok:true(,data)} | {ok:false,error}`; `unexpectedError` (L14). Recruiting has `RecruitingActionResult` (adds fieldErrors, code, report). Other areas vary: news uses `{success,…}`, pages `{ok,id}`.
- **Example: `SRC/app/admin/events/actions.ts` `updateEvent` (L133):**
  1. requireOfficer
  2. read the before row
  3. `parseEventForm` (`SRC/schemas/event.schema.ts:108`)
  4. `publication()` works out the status
  5. `prisma.event.update` (P2002 → slug taken)
  6. `reconcileEventWaitlist`
  7. `createAuditLog`
  8. revalidatePath plus `revalidateEventList`/`revalidateEventDetail`/`revalidateSeriesPages` (`SRC/server/cache/revalidate-public.ts`)
  9. `redirect`
- **Audit:** `SRC/server/audit/log.ts:19` `createAuditLog(params, tx?)`.
  - Params: `{actorUserId|null, actionType, entityType, entityId, targetUserId?, summary, before?, after?, metadata?, requestId?, ip?, userAgent?}`. It swallows its own errors.
  - Names are upper snake case:
    - actionType: CREATE/UPDATE/DELETE, INGEST, CHECKIN, …
    - entityType: EVENT, POST, PAGE, USER, NOTIFICATION, RESULT_UPLOAD, DRIVER_IDENTITY, EVENT_ATTENDANCE, SEASON, JACK_ROOM, JACK_DECK, FEATURE_FLAG, SYSTEM_SETTING, …
  - Jack's precedent: `metadata: {via:"jack", roomId}`, with the summary crediting the officer.
  - Audit page `SRC/app/admin/audit/page.tsx`; API `SRC/app/api/admin/audit-logs/route.ts`.

## 3. Areas a proposed change could call
### Events
- **Pages:** `SRC/app/admin/events/page.tsx`, `new`, `[id]/edit`, `[id]/manage`. Form: `SRC/components/admin/event-form.tsx`.
- **Actions** (`SRC/app/admin/events/actions.ts`):
  - `createEvent` L45, `updateEventStatus` L88, `updateEvent` L133 (all three redirect)
  - `deleteEvent` L187, `updateEventRegistrationConfig` L209, `overrideRegistrationStatus` L254, `reorderWaitlist` L265, `removeRegistration` L295
  - `updateEventAttendanceConfig` L304, `manualCheckIn` L327, `manualRemoveCheckIn` L335
- **Fields** (`parseEventForm`):
  - Details: title, slug, seriesId, venueId, timezone, startsAtUtc, endsAtUtc, summary, description, heroImageUrl, streamUrl
  - Registration: registrationEnabled/OpensAt/ClosesAt/Max/WaitlistEnabled/FeeCents
  - Attendance: attendanceEnabled/OpensAt/ClosesAt
  - `parseRegistrationConfigForm` (L159) adds waitlistAutoPromote.
- **Status:** `EventStatus` DRAFT, PUBLISHED, SCHEDULED (+publishedAt), IN_PROGRESS, COMPLETED, CANCELLED, POSTPONED. The effective status comes from `getEffectiveEventStatus` (`SRC/lib/events.ts:3`).
  - **Publishing doesn't send EVENT_POSTED; nothing sends EVENT_POSTED or RESULTS_POSTED.**
- **Registration** (`SRC/server/services/registration.service.ts`, Event row locked `FOR UPDATE`): registerForEvent L134, adminOverrideRegistration L345, adminRemoveRegistration L469, reconcileEventWaitlist L529, notifyPromotedUsers L23.
- **Check-in** (`SRC/server/services/attendance.service.ts`):
  - `checkInUser(eventId, userId, "QR"|"MANUAL", actorUserId)` (L19) is idempotent: it upserts EventAttendance `[eventId,userId]` with method, checkedInAt and checkedInByUserId.
  - MANUAL skips the window checks and audits `CHECKIN`/`EVENT_ATTENDANCE`.
  - removeCheckIn L111, getEventAttendanceState L154, updateAttendanceConfig L247.

### News (Post)
- **Pages:** `SRC/app/admin/news/page.tsx`, `new`, `[id]`. Form: `_components/post-form.tsx`.
- **Writes:** `SRC/server/actions/news.ts` `createPost(data)` L12 and `updatePost(id, data)` L70, validated by `newsPostSchema` (`SRC/schemas/news.schema.ts`), with tag sync. `deletePost` is in `SRC/app/admin/news/actions.ts:8`.
- **Fields:** title, slug, excerpt, coverImageUrl (must be a Cloudinary URL), bodyMd, authorId, publishedAt, tags.
- **States:** publishedAt null = draft, future = scheduled, past = published. Public posts also need visibility=public (`publishedPostWhere`, `SRC/lib/news.ts`).

### Pages
- `SRC/app/admin/pages/actions.ts:29` `savePage(id|null, {title, slug, visibility:"public"|"officers", bodyMd≤50k})` returns `{ok,id}`.
- The `lone-star-cup-rules` slug can't be renamed. Before/after goes to the audit log, and it revalidates the LSC pages.
- **There's no draft state:** `visibility="officers"` hides a page. Rendering: `renderPageMarkdown` (`SRC/lib/pages.ts`).

### Notifications
- **Page:** `SRC/app/admin/notifications/page.tsx`; composer `_components/notification-composer.tsx`.
- **Audiences:** single, multiple (UserPicker) or all (every active member); no role or event audiences. Channels IN_APP and/or EMAIL, optional scheduledFor.
- **Actions** (`SRC/app/admin/notifications/actions.ts`):
  - `sendCustomNotification(fd)` L135: checks the daily limit first (`sendAnyway` overrides), audits CREATE/NOTIFICATION.
  - cancelScheduledNotifications L69, retryFailedNotification L103, get/updateEmailSettings L259/L274, delete and bulk delete.
- **Service** (`SRC/server/services/notification.service.ts`):
  - sendNotification L40
  - `sendBulkNotification({userIds, type, title, body, actionUrl, channels, scheduledFor, metadata})` L98
  - countEmailRecipients L144, getEmailUsage L169 (`RESEND_DAILY_LIMIT` default 100, TRANSACTIONAL_HEADROOM 10)
  - shouldSendEmail L194 (marketing types need marketingOptIn), processScheduledNotifications L278, cancelNotification L471, retryNotification L481
- **Resend:** `SRC/lib/email/resend.ts` `sendEmail` L66, `sendBatchEmails` L107. Templates in `SRC/lib/email/templates/`.

### Results upload
- **Pages:** `SRC/app/admin/results/page.tsx` (`_components/upload-dialog.tsx`), and `[id]/page.tsx` + `client.tsx`, which runs the steps.
- **Actions** (`SRC/app/admin/results/actions.ts`):
  - `uploadResult(fd)` L12: parses the JSON, takes a sha256, creates RawResultUpload UPLOADED.
  - `previewParseResult(uploadId)` L72: validates, **upserts DriverIdentity per GUID**, upserts ParseReport, sets PARSED or FAILED.
  - `bindEventToUpload(uploadId, eventId, pointsSystem, sessionLabel)` L185: practice and qualifying force points NONE.
  - `ingestUpload(uploadId)` L274: one transaction with the row locked. Creates RaceSession, Participants (userId from DriverIdentity, carMappingId from CarMapping), Results (`calculatePoints` L256), Laps and Events; marks it INGESTED; audits INGEST.
  - deleteUpload L226
- **No reusable "file → import" function exists.** The logic lives in `"use server"` actions that call requireOfficer, so it has to move into a service. File types: `SRC/lib/results/ac-result-file.ts`.
- **Unmatched drivers:** participants get userId=null, and the UI warns their results won't count. Fix with `SRC/app/admin/drivers/actions.ts:8` `updateDriverMapping(identityId, userId|null)`, which back-fills participants. Cars: `SRC/app/admin/cars/actions.ts` updateCarMapping L8, createCarMapping L31.
- **Standings aren't recomputed on ingest:** that's `SRC/app/admin/seasons/actions.ts:127` `recomputeStandings(seasonId)`.

### Members
- **Admin edit:** `SRC/server/actions/users.ts:25` `updateUser(userId, payload)` takes the **whole** record (displayName, handle, bio, iRating, gradYear, major, socials, officerTitle, roleKeys, membership).
  - It replaces roles. Only admins edit officers or admins. It audits USER with before/after.
  - **There's no partial update.**
- **Self-service:** `SRC/app/drivers/[handle]/edit/page.tsx` with actions `updateProfile(fd)` L35 (displayName, iRating, bio, gradYear, major, socials; redirects, no audit), saveAvatar, clearAvatar and saveEid L121.
  - `SRC/app/account/actions.ts`: marketing opt-in, notification preferences, retire, delete. `SRC/app/account/page.tsx` links to the profile editor.

### Payments, Products, LSC entries
- **Payments** (`SRC/app/admin/payments/page.tsx`): read-only, server-paginated (`getAdminPayments`, `SRC/server/queries/payments.ts:44`, 50 per page). Filters status, kind and search; flags duplicates; links to Stripe.
- **Products:** `SRC/server/actions/products.ts:15` `updateProduct` → `SRC/server/services/product.service.ts:26` `applyProductUpdate`.
- **LSC entries** (`SRC/app/admin/league-entries/page.tsx`):
  - `getEntrantRows` (`SRC/server/queries/league-entrants.ts:50`); CSV export.
  - Actions saveEntrantApplication L27, grantEntrantEntry L50, revokeEntrantEntry L68.
  - Services in `SRC/server/services/league-entry.service.ts`.

### Instagram
- **Files:** `SRC/app/admin/instagram/page.tsx`, `actions.ts`, `client.tsx`; `SRC/lib/instagram.ts`.
- **API:** getProfile (`/me`), getRecentMedia (`/me/media`, 24 posts), refreshToken. **Read-only.**
- **Connection:** no OAuth flow; an officer pastes a long-lived token. **The only scope is `instagram_business_basic`** (`docs/instagram.md`).
  - The token is stored in SystemSetting `"instagram"`: `{token, userId, username, connectedAt, tokenRefreshedAt, tokenExpiresAt, lastSyncAt, lastError, lastErrorAt}`.
- **Service:** `SRC/server/services/instagram.service.ts` (getInstagramStatus L56, connectInstagram L62, disconnectInstagram L94, setInstagramPostHidden L101, syncInstagram L120: copies posts into InstagramPost and images into Cloudinary, refreshes the token weekly). Hourly cron `/api/cron/instagram`.

### Gallery
- Browser uploads go to Cloudinary through the unsigned preset, then `createImage(publicId, {albumId, width, height})` (`SRC/app/admin/gallery/actions.ts` L20).
- Album actions: createAlbum L170, updateAlbum L191 (`AlbumInput` = `{title, date, description, eventId}`).
- **Server-side upload:** `SRC/server/cloudinary.ts` `uploadRemoteImage(url, publicId)` L41 (signed; needs the API key and secret), destroyImage L68, signVideoUpload L22.

### Recruiting
- **Routes:** `/admin/recruiting` (list), `/admin/recruiting/[id]` (detail; logs APPLICATION_VIEWED), `/cycles`, `/emails`, `/export`.
- **Actions:** `SRC/app/admin/recruiting/actions.ts` (previewDecisionAction L61, decideAction L68, bulkDecideAction L82, addReviewAction L96, …).
- **Services:** `recruiting.service.ts` (setTrackStatus L680, addReview L784), `recruiting-email.service.ts` (decideAndNotify L563, bulkDecide L642), `recruiting-cycle.service.ts`.

## 4. Flags and settings
- **`FeatureFlag {key, enabled}`** (schema L583): `"recruiting"` (`isRecruitingEnabled`, set only by seed), and a joke flag toggled in `SRC/app/admin/tools/actions.ts`. **No admin UI toggles flags.**
- **`SystemSetting {key, value: JSON string}`** (schema L895): helpers in `SRC/lib/email/settings.ts` (`getSystemSetting<T>` L7, `setSystemSetting` L25). Keys: notifications.email.enabled/from, homepage.hotlap/clip/featuredVideo, instagram.
- **Env toggles:** `NEXT_PUBLIC_SHOP_ENABLED`, `RESEND_DAILY_LIMIT`, `JACK_DATABASE_URL`, `ANTHROPIC_API_KEY`, `BLOB_*`.

## 5. Patterns close to "draft → review → apply"
- **`draft_event`:** a DRAFT event, published on the edit page; an `event_draft` card in the room.
- **Recruiting decisions:** `previewDecisionEmail` (`recruiting-email.service.ts:146`) returns an editable email without writing; `decideAndNotify` applies it with an override, guarded by `expectedStatus`. **A model for safely applying a proposal later.**
- **Results:** upload → parse (preview) → bind → ingest, each step clicked by an officer.
- **Content states:** Event DRAFT/SCHEDULED; Post publishedAt null or future; Page visibility officers; Notification PENDING + scheduledFor; Application DRAFT.
- **Jack decks:** every change is a JackDeckVersion that's never modified, and can be undone (`SRC/server/jack/decks/service.ts`).
- **Confirm before destructive actions:** `useConfirm`, `RowMenu` destructive.
