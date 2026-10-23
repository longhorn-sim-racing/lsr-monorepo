# Microsoft Graph for Jack 2.0: SharePoint files, Teams channel messages, meeting transcripts, posting

Researched 2026-10-22 from learn.microsoft.com (pages under Sources). Anything marked **UNVERIFIED** was not stated in the docs I read, or the docs disagree. Graph base URL: `https://graph.microsoft.com/v1.0`. Every call below is app-only (no signed-in user), read-only, and runs from a Vercel function or a pg_cron/pg_net job.

## 1. What we'd use it for

The club's Teams team and its SharePoint site live in UT's Microsoft 365 tenant, which we don't control, so every permission is a request to UT IT. We'd use Graph to: **(a)** read files in our team's SharePoint site through `Sites.Selected`, which only works on sites IT explicitly grants. Jack keeps a text index of officer docs (budgets, sponsor packets, rules drafts) and answers from it. **(b)** read our team's channel messages through RSC (`ChannelMessage.Read.Group`), which a team owner grants for this one team when installing our Teams app. That gives Jack the club's "memory" of announcements and decisions. **(c)** read meeting transcripts so Jack can draft notes and action items. This is the hardest ask (see 3h). **(d)** post Jack's digests and reminders into a channel. Nothing here moves money or writes to UT data, apart from (d) posting a message.

## 2. Auth and setup

**One Entra app ("LSR Jack") with client credentials.** Get a token with `POST https://login.microsoftonline.com/{UT-tenant-id}/oauth2/v2.0/token` and form fields `grant_type=client_credentials`, `client_id`, `client_secret` (or, with a certificate, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` plus a signed `client_assertion`), and `scope=https://graph.microsoft.com/.default`. The response is `{"token_type":"Bearer","expires_in":3599,"access_token":"..."}`. **No refresh token** is issued in this flow. Cache the token for about 55 minutes and request a new one after that. `.default` returns whatever app permissions and grants the tenant has given. RSC grants don't show up in the token's roles and are checked per team at call time (**UNVERIFIED** mechanism; the docs only say RSC is checked against the installed app).

**Where the app is registered.** Register it in UT's tenant: either IT creates it, or IT lets us create it there. Three reasons:
- If an RSC Teams app's Entra app lives in a different tenant, only a tenant admin can install it (`WebApplicationInfoIdOfSideloadedAppMustBeInTheSameTenantAsUser`).
- New multi-tenant bots can't be created after 2025-07-31. A single-tenant bot must sit in the tenant where Teams runs.
- A Teams app and its Entra app must map 1:1.

A multi-tenant app in an LSR-owned tenant plus UT admin consent would also work for `Sites.Selected`. It wouldn't work for the bot.

**Permissions, narrowest that work:**

| Goal | Permission | Type | Who grants |
|---|---|---|---|
| (a) Files | `Sites.Selected` | Application, admin consent | IT consents, then IT grants role `read` on our site only (step below) |
| (b) Channel messages | `ChannelMessage.Read.Group` | RSC application, in the Teams app manifest | Team owner, when installing the app in our team |
| (b) optional | `ChannelSettings.Read.Group` | RSC | Team owner. Only needed to list channels (`GET /teams/{id}/channels` lists it as the least-privileged application permission); we can hard-code channel IDs instead |
| (c) Channel meeting transcripts | `OnlineMeetingTranscript.Read.All` + `OnlineMeetings.Read.All` | Application, admin consent | IT, plus an application access policy and a tenant toggle (3h) |
| (d) Posting | None for Workflows. For a bot: Azure Bot resource on the same Entra app | n/a | IT allows the Teams app or Workflows |

We would **not** ask for `Files.Read.All`, `Sites.Read.All`, `ChannelMessage.Read.All`, `Group.Read.All`, any write scope, or `Teamwork.Migrate.All`.

**How IT grants per-site access.** Three steps, and all three are required:
1. Admin-consent `Sites.Selected`.
2. Someone holding `Sites.FullControl.All` calls `POST /sites/{siteId}/permissions` with `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<our client id>","displayName":"LSR Jack"}}]}`. The response is 201 and returns `grantedToIdentitiesV2` (`grantedToIdentities` is deprecated). If they call it with delegated permissions, the admin needs the SharePoint Administrator role and must be a member of the site.
3. Our token carries `Sites.Selected`.

Revoke with `DELETE /sites/{siteId}/permissions/{id}`, or by revoking consent. The four roles are `read`, `write`, `owner` and `fullcontrol`; we need `read`. PnP PowerShell `Grant-PnPEntraIDAppSitePermission` is a common alternative (`Grant-PnPAzureADAppSitePermission` is now an alias for it). Finer Selected scopes also exist (`Lists.SelectedOperations.Selected`, `ListItems.SelectedOperations.Selected`, `Files.SelectedOperations.Selected`) if IT would rather grant one library or folder than the whole site; a grant below site level breaks permission inheritance on that item.

**Teams app (RSC).** The manifest (v1.12+ for this `authorization` format; application RSC works from v1.6, where v1.11 and earlier list permissions in `webApplicationInfo.applicationPermissions` instead) needs `"webApplicationInfo":{"id":"<entra app id>","resource":"https://lsr-jack"}` (`resource` can be any string, but it must be present) and `"authorization":{"permissions":{"resourceSpecific":[{"name":"ChannelMessage.Read.Group","type":"Application"}]}}`. Application RSC can only be granted by the resource owner, here a **team owner**, at install time. (The RSC overview says this in prose, but its summary table says "a team owner or member"; plan on a team owner doing the install.)

Tenant settings that must allow this:
- **Team RSC config** must not be `DisabledForAllApps`. The other states are `ManagedByMicrosoft` (the default, which lets users consent) and `EnabledForAllApps`. IT checks or sets it with `Get/Set-MgBetaTeamRscConfiguration`.
- **The app has to reach our team.** Either an admin uploads it to the org catalog (Teams admin center → Manage apps → Upload) and app permission policies allow it, or custom upload is allowed. Custom upload needs org-wide "Let users interact with custom apps in preview" on, plus an app setup policy with "Upload custom apps" assigned to Gray, plus our team's "Allow members to upload custom apps". If the team setting is off, a policy-enabled **team owner** can still upload.

Check that the install worked with `GET /beta/teams/{teamId}/permissionGrants`: `clientAppId` should equal our app ID.

**Env vars (proposed names):**
- Auth and endpoints: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (or `MS_CLIENT_CERT_PEM` + `MS_CLIENT_CERT_THUMBPRINT`), `MS_LOGIN_BASE_URL` (default `https://login.microsoftonline.com`; the fake overrides it), `MS_GRAPH_BASE_URL` (default `https://graph.microsoft.com/v1.0`).
- Targets: `MS_SITE_ID`, `MS_DRIVE_ID`, `MS_TEAM_ID`, `MS_CHANNEL_IDS` (comma-separated).
- Webhook secrets and posting: `MS_GRAPH_CLIENT_STATE` (change notification secret, 128 characters max), `TEAMS_WORKFLOW_WEBHOOK_URL` (a secret).
- Bot only: `MS_BOT_SERVICE_URL` (default `https://smba.trafficmanager.net/teams/`) and `MS_BOT_OPENID_URL` (default `https://login.botframework.com/v1/.well-known/openidconfiguration`).

## 3. Endpoints we need

Shared error shape: `{"error":{"code":"...","message":"...","innerError":{"date":"...","request-id":"...","client-request-id":"..."}}}`. Handle these:
- 401 (token expired or bad): refresh the token once.
- 403 `accessDenied`/`Forbidden`: the grant is missing. Alert, don't retry.
- 404 `itemNotFound`.
- 429: honor `Retry-After`, otherwise back off exponentially.
- 503/504: back off.

Lists page through `@odata.nextLink`, an absolute URL we follow as-is.

### 3a. Find the site and drive (one-time, store the IDs)
- `GET /sites/{hostname}:/sites/{path}` returns `{"id":"utexas.sharepoint.com,<siteCollectionGuid>,<webGuid>","displayName":"...","webUrl":"..."}`. The docs list only `Sites.Read.All` for this call. Widely reported to work with `Sites.Selected` once granted (**UNVERIFIED**). Simplest is to ask IT for the site ID. The `utexas.sharepoint.com` hostname is **UNVERIFIED**.
- `GET /sites/{site-id}/drive` (default "Documents" library) or `GET /sites/{site-id}/drives` returns `{"id":"b!...","driveType":"documentLibrary","name":"Documents"}`.
- Each channel's folder is a subfolder named after the channel. `GET /teams/{id}/channels/{id}/filesFolder` would tell us, but its least-privileged application permission is `Files.Read.All` (not narrow), so hard-code folder paths instead. (Its table also lists `File.Read.Group`, which isn't in the Teams RSC permission list; **UNVERIFIED** whether a team owner can grant it.) **Private and shared channels have their own SharePoint sites**, and each needs its own `Sites.Selected` grant. Private channels on Microsoft's newer model keep files in their site's root folder rather than a channel-named subfolder.

### 3b. List and sync files
- `GET /drives/{drive-id}/items/{item-id}/children` or `GET /drives/{drive-id}/root:/{path}:/children`. Supports `$select`, `$top`, `$orderby`, `$expand`, `$skipToken`. Default page size is 200, and `@odata.nextLink` appears when there's more.
- **Preferred: `GET /drives/{drive-id}/root/delta`.** Follow `@odata.nextLink` until you get `@odata.deltaLink`, then store that deltaLink and call it on the next run. Variants:
  - `?token=latest` returns only a fresh deltaLink.
  - `?token=2026-10-01T00%3A00%3A00Z` resumes from a timestamp (SharePoint/ODB only).
- Delta rules:
  - Deleted items come back with a `deleted` facet.
  - Track items by `id`, because `parentReference.path` is omitted.
  - The same item can appear twice; use the last occurrence.
  - **410 Gone** with `resyncChangesApplyDifferences` or `resyncChangesUploadDifferences` plus a `Location` header means restart enumeration from that URL.
- Trimmed delta item: `{"id":"01ABC...","name":"Budget FA26.xlsx","size":48211,"eTag":"...","cTag":"...","lastModifiedDateTime":"2026-10-20T15:02:11Z","webUrl":"https://.../Budget%20FA26.xlsx","file":{"mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},"parentReference":{"driveId":"b!...","id":"01DEF..."}}`. Folders have `"folder":{"childCount":4}` instead of `file`.
- Permission tables for children and delta list `Files.Read.All`, not `Sites.Selected`. The Selected overview says access is decided by the grant on the resource, so these should work (**UNVERIFIED** per endpoint; test on first call).

### 3c. Download and get text
- `GET /drives/{drive-id}/items/{item-id}/content` returns **302** with `Location: <pre-authenticated URL>`. Follow it **without** an `Authorization` header. The URL "might expire within minutes", so never store it. The same URL is available as `@microsoft.graph.downloadUrl` via `?$select=id,@microsoft.graph.downloadUrl`. A `Range: bytes=0-1023` header goes on that download URL, not on `/content`, and returns 206. `If-None-Match: <eTag>` returns 304 if the file hasn't changed.
- **Graph has no "get text" endpoint.** `?format=pdf` converts Office files (and `format=html` converts loop/whiteboard files), but only for files **up to 2 MB**. Its app-permission row lists `Files.ReadWrite.All`, so whether it works under `Sites.Selected` is **UNVERIFIED**. Plan: download the original and extract text ourselves (docx, xlsx, pptx, pdf, txt/md/csv/vtt), skip files over about 20 MB, and store the text and `eTag` in Postgres.

### 3d. Search files
- `GET /drives/{id}/root/search(q='...')` is **explicitly not supported with `Sites.Selected`** ("This method doesn't support the Sites.Selected application permission").
- The Microsoft Search API (`POST /search/query`) lists only `Files.Read.All` and `Sites.Read.All` as application permissions, so treat it as unavailable under `Sites.Selected`.
- Plan: Jack searches our own Postgres full-text index, which the delta sync (3b) keeps current.

### 3e. Read channel messages (RSC `ChannelMessage.Read.Group`)
- `GET /teams/{team-id}/channels/{channel-id}/messages?$top=50&$expand=replies`. Default page is 20, max 50. `$expand=replies` returns up to 200 replies per the parameter table (an example on the same page says 1,000), plus `replies@odata.nextLink` for more; follow the nextLink either way. No other OData options (such as `$filter`) are supported on this list. Root messages are sorted by the last modified time of the whole reply chain. App-context calls must come from the channel owner's tenant (fine for us).
- Single message: `GET .../messages/{message-id}`. Replies: `GET .../messages/{message-id}/replies` and `.../replies/{reply-id}`.
- Delta: `GET /teams/{team-id}/channels/{channel-id}/messages/delta` lists `ChannelMessage.Read.Group` in the PowerShell reference (`Get-MgTeamChannelMessageDelta`). Both the v1.0 and beta REST pages for chatMessage delta now document only `/users/{id}/chats/getAllMessages/delta` (`Chat.Read.All`), so the channel endpoint has no REST reference page. Its query options (`$top` ≤ 50, `$filter=lastModifiedDateTime gt ...` with `gt` only, an eight-month window) come from that chats page and are **UNVERIFIED** for channels.
- `GET /teams/{id}/channels/getAllMessages` needs `ChannelMessage.Read.All`, so it's **not usable**.
- Trimmed message:
```json
{"id":"1616965872395","replyToId":null,"etag":"1616965872395","messageType":"message",
 "createdDateTime":"2026-10-21T21:11:12.395Z","lastModifiedDateTime":"2026-10-21T21:11:12.395Z",
 "deletedDateTime":null,"subject":null,"webUrl":"https://teams.microsoft.com/l/message/...",
 "from":{"application":null,"user":{"id":"8ea0e38b-...","displayName":"Robin Kline","userIdentityType":"aadUser"}},
 "body":{"contentType":"html","content":"Hello <at id=\"0\">Jane Smith</at>"},
 "channelIdentity":{"teamId":"fbe2bf47-...","channelId":"19:4a95...@thread.tacv2"},
 "attachments":[],"mentions":[{"id":0,"mentionText":"Jane Smith","mentioned":{"user":{"id":"ef1c...","displayName":"Jane Smith"}}}],
 "reactions":[]}
```
- Handling notes:
  - Strip the HTML in `body.content`.
  - Skip `messageType` `systemEventMessage`/`unknownFutureValue`. Send `Prefer: include-unknown-enum-members` to get real enum values.
  - Treat a non-null `deletedDateTime` as a delete.
  - Inline images point to `.../hostedContents/{id}/$value`, which needs auth.

### 3f. Change notifications for channel messages (avoids polling; see 4 and 6)
- `POST /subscriptions` with `{"changeType":"created,updated,deleted","notificationUrl":"https://lsr.../api/graph/notify","lifecycleNotificationUrl":"https://lsr.../api/graph/lifecycle","resource":"/teams/{team-id}/channels/{channel-id}/messages","includeResourceData":false,"expirationDateTime":"<now+3d>","clientState":"<MS_GRAPH_CLIENT_STATE>"}`. That resource accepts `ChannelMessage.Read.Group` (RSC).
- `includeResourceData:false` means no encryption certificate is needed. We GET the message ourselves after each notification.
- Subscription rules:
  - Max lifetime is 4,320 min (3 days). Any expiry under 45 minutes out is bumped to 45 minutes.
  - `lifecycleNotificationUrl` is **required** for Teams resources when the expiry is more than 1 hour away. It can't be added to an existing subscription by PATCH; delete and recreate instead.
  - A duplicate `changeType` + `resource` returns 409.
- Renew with `PATCH /subscriptions/{id}` `{"expirationDateTime":"..."}`. Delete with `DELETE /subscriptions/{id}`.
- Response (201): `{"id":"7f105c7d-...","resource":"...","expirationDateTime":"...","clientState":"..."}`.

### 3g. Posting a message
- **Graph cannot post app-only.** `POST /teams/{id}/channels/{id}/messages` accepts only `Teamwork.Migrate.All` for application permissions ("only supported for migration"). The RSC permission `ChannelMessage.Send.Group` exists, but the post API doesn't list it (**UNVERIFIED** that it works).
- **Option 1, Workflows webhook (simplest).**
  - A team member creates a flow from the template "Post to a channel when a webhook request is received" (trigger: "When a Teams webhook request is received"). We `POST` to the URL it shows (docs example `https://xxxxx.logic.azure.com:443/...`).
  - Request body: `{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"$schema":"http://adaptivecards.io/schemas/adaptive-card.json","type":"AdaptiveCard","version":"1.2","body":[{"type":"TextBlock","text":"...","wrap":true}]}}]}`.
  - POST only. With auth "Anyone", send **no** auth header, and the URL itself is the secret. "Any user in my tenant" needs an Entra token (claims **UNVERIFIED** for an app caller).
  - The response code is **UNVERIFIED** (expect 202).
- **Option 2, bot (full-featured, more IT work).**
  - Setup: an Azure Bot resource (needs an Azure subscription) on the same single-tenant Entra app, Teams channel enabled, the bot added to our Teams app manifest, and the app installed in the team.
  - Token: `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `scope=https://api.botframework.com/.default` (expires_in 3600).
  - New thread: `POST {serviceUrl}/v3/conversations` with `{"isGroup":true,"bot":{"id":"<appId>","name":"Jack"},"channelData":{"channel":{"id":"19:...@thread.tacv2"},"tenant":{"id":"<tenant>"}},"activity":{"type":"message","text":"..."}}`. Returns `{"id":"<conversationId>","activityId":"<id>"}`.
  - Update: `PUT {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}`.
  - If someone uninstalled or blocked the bot, posting returns 403 `MessageWritesBlocked`.
  - Bonus: a bot with `ChannelMessage.Read.Group` **receives every channel message as a webhook**, no polling.

### 3h. Meeting transcripts (channel meetings)
- **What it takes.**
  - `OnlineMeetingTranscript.Read.Chat` (RSC) "applies only to scheduled private chat meetings, not to channel meetings. For a channel meeting, use `OnlineMeetingTranscript.Read.All` with an application access policy."
  - Tenant toggle: "By default, Microsoft Graph access is off." IT must turn on Teams admin center → Meetings → Meeting settings → Transcript API access → **Microsoft Graph access**, or run `Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess true [-EnableAttributedTranscripts true] -Identity Global`. Speaker attribution is a separate toggle and is off by default.
  - Application access policy: `New-CsApplicationAccessPolicy -Identity LSR-Jack -AppIds "<id>"` then `Grant-CsApplicationAccessPolicy -PolicyName LSR-Jack -Identity "<organizer user id>"` for each officer who schedules meetings. Changes take up to 30 minutes.
  - Missing policy error: 403 `"No application access policy found for this app"`.
- **Calls.**
  - Find the meeting from the channel meeting's join link: `GET /users/{organizerId}/onlineMeetings?$filter=JoinWebUrl%20eq%20'{url-encoded joinWebUrl}'` (needs `OnlineMeetings.Read.All`). Returns a one-item collection with `id`.
  - List: `GET /users/{organizerId}/onlineMeetings/{meetingId}/transcripts` returns `[{"id":"MSMjMCMj...","meetingId":"MSo1N2Y5...","callId":"af63...","createdDateTime":"...","endDateTime":"...","contentCorrelationId":"...","transcriptContentUrl":"...","meetingOrganizer":{"user":{"id":"..."}}}]`.
  - Content: `GET .../transcripts/{id}/content` with `Accept: text/vtt` (or `$format=text/vtt`) returns `WEBVTT\n\n00:00:16.246 --> 00:00:17.726\n<v User Name>This is a transcript test.</v>`. `Accept: application/vnd.microsoft.graph.transcript+text` returns the same without speakers (this format works only through the `Accept` header, not `$format`). Speaker attribution is off by default, so until IT turns it on, `text/vtt` returns 403 `SpeakerAttributionNotAllowed`; request the unattributed format by default. `.../metadataContent` returns VTT cues whose payload is JSON with `speakerName` and `spokenText`. The docx format was deprecated 2023-05-31.
  - `getAllTranscripts` and its delta "doesn't support getting call transcripts from channel meetings."
  - List transcripts doesn't support meetings made with the create-onlineMeeting API that aren't tied to a calendar event. Channel meetings are calendar events, so this shouldn't bite.
- **Errors (branch on `innerError.code`).**
  - 403 `GraphAccessToTranscriptsDisabled`: no workaround.
  - 403 `SpeakerAttributionNotAllowed`: retry with the unattributed `Accept`.
  - Works only while the meeting hasn't expired.
- **Doc conflict.** The Teams overview (updated 2026-09) still says these APIs "support private chat meetings, channel meetings, and ad hoc calls only in beta". The v1.0 reference says list transcripts covers "all meeting types except live events", and get transcript says "For a channel meeting, use `OnlineMeetingTranscript.Read.All` with an application access policy." The v1.0 pages are the more specific ones, but which is right is **UNVERIFIED** until tested.
- **Low-privilege fallback (recommended to start).** The organizer downloads the transcript (.vtt/.docx) from the meeting recap into a "Transcripts" folder on our SharePoint site, and Jack picks it up through 3b and 3c with no extra permission.

## 4. Webhooks and events

**Graph change notifications (3f).**
- **Endpoint validation:** on create, Graph sends `POST {notificationUrl}?validationToken=<opaque>` (and the same to `lifecycleNotificationUrl`). Reply within **10 s** with `200`, `Content-Type: text/plain`, and the URL-decoded token as the body.
- **Notifications:** `{"value":[{"subscriptionId":"...","changeType":"created","clientState":"...","tenantId":"...","subscriptionExpirationDateTime":"...","resource":"teams('fbe2...')/channels('19:...@thread.tacv2')/messages('1612293113399')","resourceData":{"id":"1612293113399","@odata.type":"#Microsoft.Graph.chatMessage","@odata.id":"teams('...')/channels('...')/messages('...')"}}]}`. Reply resources probably carry `/replies('...')` (**UNVERIFIED** format; parse both).
- **Verification:** there's **no HMAC signature** on basic notifications. Compare `clientState` to our secret in constant time and drop mismatches. (Rich notifications carry `validationTokens` JWTs, which we don't use.)
- **Response timing:**
  - Return `202` within **3 s**. Queue the work (insert a row and let pg_cron process it), don't run it inline.
  - Non-2xx responses and timeouts are retried with backoff for up to **4 hours**.
  - If more than 10% of responses take over 3 s, the endpoint is marked "slow" and notifications are delayed 10 minutes.
  - If more than 15% take over the 10 s retry timeout, notifications are dropped for 10-minute windows.
- **Lifecycle notifications:** `{"value":[{"subscriptionId":"...","subscriptionExpirationDateTime":"...","tenantId":"...","clientState":"...","lifecycleEvent":"reauthorizationRequired|subscriptionRemoved|missed"}]}`. Reply 202, then handle by event:
  - `reauthorizationRequired` (sent for all resources): `POST /subscriptions/{id}/reauthorize`, or `PATCH` with a new expiry. Never send both within 10 minutes.
  - `subscriptionRemoved` (sent for Teams chatMessage): recreate the subscription, then resync with delta.
  - `missed`: resync with delta. The docs say `missed` is only sent for Outlook message, event and contact subscriptions, **not chatMessage**, so a dropped channel-message notification produces no signal. The daily reconcile in section 5 is what catches those; still handle `missed` in case support is added.

**Bot inbound (Option 2 only).** Verify the `Authorization: Bearer` JWT:
- Fetch `https://login.botframework.com/v1/.well-known/openidconfiguration`, then its `jwks_uri` (`https://login.botframework.com/v1/.well-known/keys`). Refresh the keys at least every 24 hours.
- Algorithm RS256; `iss` = `https://api.botframework.com`; `aud` = our app ID.
- Allow 5 minutes of clock skew.
- The `serviceUrl` claim must equal `activity.serviceUrl`.
- Reject with 403 on any failure.

**Workflows (Option 1)** has no inbound events.

## 5. Rate limits, quotas, plan limits, retention

- **Teams throttling** has four dimensions (per app, per app per tenant, per resource, per user), and any one of them can trigger a 429. The steady-state limit is about 83% of the listed burst.

  | Call | Per app per tenant | Per resource |
  |---|---|---|
  | `GET .../messages` | 20 rps | **1 rps per channel** |
  | `POST .../messages` | 50 rps | 1 rps per channel |
  | `GET /teams/{id}` | 30 rps | 4 rps per team |
  | Other Teams GETs | 30 rps | 1 rps per channel |
  | `/subscriptions` POST/PATCH/DELETE | 500 per 20 s | n/a |
  | `POST /subscriptions/{id}/reauthorize` | 1,000 per 20 s | n/a |
  | Global, per app across all tenants | 130,000 per 10 s | n/a |

  The `POST .../messages` and default (unlisted) Teams calls also carry a 1 rps per-user limit, which doesn't apply to app-only calls.

- **SharePoint/OneDrive** throttling is resource-unit (RU) based. Per app per tenant, the limit scales with the tenant's license count: 1,250 RU/min and 1,200,000 RU/day at 0-1,000 licenses, up to 6,250 RU/min and 6,000,000 RU/day above 50,000 (UT is likely in the top band). Costs: 1 RU for a single-item get, a file download, or delta with a token; 2 RU for list children, delta without a token, or any write; 5 RU for permission operations. Throttled requests get 429 or 503 with `Retry-After`. At our volume (one site, a few hundred files) it won't matter.
- **Teams polling rule:** "If your app polls to see whether a resource has changed, you can only do that once per day". Breaking it violates the Microsoft APIs Terms of Use. So: change notifications (or a bot) for live messages, plus **at most one daily delta reconcile per channel**. SharePoint delta isn't under this Teams rule. An hourly or daily pg_cron delta is fine.
- **Cost:**
  - Teams APIs have **not been metered since 2025-08-25** ("no billing configuration is required"), so no Azure billing is needed for Graph.
  - Azure Bot: standard channels (Teams counts as one) have unlimited messages, and the F0 tier exists. But the resource needs an Azure subscription.
  - Workflows: invoke limit of 4,500 per 5 minutes on the Low performance profile. The Teams connector's Flow bot post actions allow 25 non-GET calls per connection per 300 seconds (we'd send a few per day).
- **Retention and lifetimes:**
  - Message and file retention follows UT's M365 retention policies (**UNVERIFIED**; ask IT).
  - Chat delta covers 8 months (**UNVERIFIED** for channels).
  - Transcripts are only available until the meeting expires.
  - Max subscription lifetimes: chatMessage 3 days, driveItem about 30 days.
  - Pre-authenticated download URLs last minutes.

## 6. Gotchas, policy and privacy

- **Protected APIs.** App-only reads of Teams messages used to require filing a protected-API request form. The official page (`/graph/teams-protected-apis`) now returns 404 (rechecked 2026-10-22). The error text quoted secondhand reads "...in application-only context **when not using Resource Specific Consent**", which suggests RSC is exempt (**UNVERIFIED**). If we get 403 "requires Protected API access", ask IT; the historical form was `aka.ms/teamsgraph/requestaccess`.
- **RSC only covers the team where the app is installed.** If the owner uninstalls it, access ends. RSC calls "aren't attributed to a user", so the app can see everything in standard channels.
- **Private and shared channels** have separate sites and memberships. Whether RSC message reads cover them is **UNVERIFIED**. Keep Jack to standard channels unless tested.
- **`Sites.Selected` gaps:**
  - No drive search (3d).
  - Format conversion is likely blocked (3c).
  - `filesFolder` needs `Files.Read.All`.
  - Each private or shared channel site needs its own grant.
- **Transcripts are the expensive ask.** Graph access is a tenant-wide toggle that's off by default, and the app permission is tenant-wide too (narrowed only by the access policy). Expect IT to say no; start with the manual-export fallback.
- **Workflows caveats:**
  - Flows belong to a user, so add a co-owner or the flow is orphaned when that person leaves.
  - Flow bot can't post in private channels yet.
  - About 28 KB per message.
  - Connectors and classic incoming webhooks are being retired, so don't build on them.
  - Workflows (Power Automate) itself must be allowed in UT's tenant (**UNVERIFIED** for UT).
- **Bot caveats:**
  - Single-tenant only for new bots, so the app must be in UT's tenant.
  - Needs an Azure subscription. Whether the subscription can live in a different directory than the app is **UNVERIFIED**; a 2026 Microsoft Q&A moderator answer (not official docs) says splitting the bot resource and the app registration across tenants isn't supported, so plan for both in UT's tenant.
  - Teams Developer Portal bot creation reportedly fails with "Multitenant bot creation is deprecated" (forum reports, not docs).
- **Vercel fit.** Webhook routes must answer within 3 s (Graph) and 10 s (validation), so write a row and return. Heavy fetching and extraction goes to a pg_cron-driven route within the 300 s limit. Renew subscriptions about every 48 hours from pg_cron via pg_net.
- **Privacy:**
  - Channel messages, files and transcripts are UT data about students. Store only text Jack needs, limit it to officers, and honor deletes (`deleted` facet / `deletedDateTime`) by purging our copy.
  - Announce in the team that Jack reads the channels, since installing the app is the consent and members should know.
  - Ask IT whether UT data-classification rules allow copying this text to our Supabase project (**UNVERIFIED** policy).
  - Never send Graph tokens or download URLs to the model.

## 7. How to fake it locally

One fake HTTP server (for example `scripts/fakes/msgraph.ts`) on `localhost`, with `MS_LOGIN_BASE_URL`, `MS_GRAPH_BASE_URL`, `MS_BOT_SERVICE_URL` and `MS_BOT_OPENID_URL` pointed at it. It must reproduce:

- **Token endpoint:** `POST /{tenant}/oauth2/v2.0/token` (form-encoded). Return `{"token_type":"Bearer","expires_in":3599,"access_token":"fake.<scope>.<random>"}` for a known client ID and secret. Otherwise return 400 `{"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided...","error_codes":[7000215]}`. Graph routes return 401 `InvalidAuthenticationToken` on a missing or expired token.
- **Grants model:** a flag for whether the site is granted and whether RSC is installed. When off, return 403 `{"error":{"code":"accessDenied",...}}`, so we can test the "IT revoked us" path.
- **Sites and drives:**
  - Site by path and `/sites/{id}/drive`, with realistic IDs (`host,guid,guid` and `b!...`).
  - `children` paged at a configurable size, with absolute `@odata.nextLink` URLs on the fake host.
  - `root/delta` with nextLink/deltaLink, `deleted` facets, `token=latest`, and a switch that returns **410** `resyncChangesApplyDifferences` with a `Location` header.
  - `/content` returns **302** to `/dl/{one-time-token}`, which needs no auth, expires after N seconds, and supports `Range` (206). `If-None-Match` returns 304.
  - Fixture files: docx, xlsx, pptx, pdf, md, vtt.
  - `root/search(q=...)` returns 403 (mirrors the `Sites.Selected` limitation).
- **Channel messages:**
  - List with `$top` ≤ 50 (400 above that) and `$expand=replies`.
  - Single get, replies, and delta. The `chatMessage` shape is exactly as in 3e: HTML bodies with `<at>`, a `systemEventMessage`, a deleted message, and epoch-millisecond string IDs.
  - Channel IDs look like `19:...@thread.tacv2`.
- **Subscriptions:**
  - `POST /subscriptions` really calls our `notificationUrl?validationToken=...` (and the lifecycle URL). It requires a 200 text/plain echo within 10 s.
  - Enforces max 4,320 minutes (bumping anything under 45 minutes up to 45), a `lifecycleNotificationUrl` when the expiry is more than 1 hour out, and 409 on duplicates.
  - Supports PATCH, DELETE and `/reauthorize`.
  - A dev route `POST /_fake/emit` sends change notifications (with or without the right `clientState`) and lifecycle events, and records our response code and latency (flags anything over 3 s). Real Graph doesn't send `missed` for chatMessage subscriptions, so the fake should default to `reauthorizationRequired` and `subscriptionRemoved` and emit `missed` only when asked.
- **Transcripts:**
  - The `onlineMeetings?$filter=JoinWebUrl eq '...'` lookup, the transcripts list, and `/content` with `Accept` negotiation (VTT with `<v Name>`, or unattributed).
  - Toggles that return 403 `GraphAccessToTranscriptsDisabled`, 403 `SpeakerAttributionNotAllowed`, and 403 "No application access policy found for this app".
- **Throttling:** a switch that returns 429 with `Retry-After: 2`, and per-channel 1 rps enforcement.
- **Workflows webhook:** `POST /workflows/{id}` validates `type=="message"` and `attachments[0].contentType=="application/vnd.microsoft.card.adaptive"`. It returns 400 if an auth header is sent in "Anyone" mode, otherwise 202, and logs cards for test assertions.
- **Bot connector:**
  - Token endpoint for `scope=https://api.botframework.com/.default`.
  - `POST /v3/conversations` returns `{id, activityId}`; `PUT /v3/conversations/{id}/activities/{id}` updates; a switch returns 403 `MessageWritesBlocked`.
  - Serves an OpenID config and JWKS so the fake can **sign inbound activities** (RS256, `iss` `https://api.botframework.com`, `aud` our app ID, `serviceUrl` claim). Our verifier is tested against valid, expired, wrong-aud and wrong-serviceUrl tokens.

## 8. Sources

- https://learn.microsoft.com/en-us/graph/permissions-selected-overview
- https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-search?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/channel-get-filesfolder?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent
- https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/grant-resource-specific-consent
- https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings
- https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/channel-getallmessages?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/chatmessage-delta?view=graph-rest-1.0 (and the beta version)
- https://learn.microsoft.com/en-us/powershell/module/microsoft.graph.teams/get-mgteamchannelmessagedelta?view=graph-powershell-1.0
- https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage
- https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
- https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0 (polling requirements)
- https://learn.microsoft.com/en-us/graph/metered-api-list
- https://learn.microsoft.com/en-us/graph/throttling-limits
- https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts
- https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy
- https://learn.microsoft.com/en-us/microsoftteams/meeting-transcript-api-access
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
- https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/what-are-webhooks-and-connectors
- https://learn.microsoft.com/en-us/connectors/teams/ (Microsoft Teams webhook trigger)
- https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages
- https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- https://learn.microsoft.com/en-us/previous-versions/microsoftteams/platform/resources/bot-v3/bot-conversations/bots-conv-proactive
- https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0
- https://learn.microsoft.com/en-us/azure/bot-service/abs-quickstart?view=azure-bot-service-4.0
- https://azure.microsoft.com/en-us/pricing/details/bot-services/
- Added in the 2026-10-22 check: https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0, https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0, https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0, https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0, https://learn.microsoft.com/en-us/graph/api/search-query?view=graph-rest-1.0, https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online, https://pnp.github.io/powershell/cmdlets/Grant-PnPAzureADAppSitePermission.html
- Secondary (protected-API history only): Microsoft Q&A threads and vendor guides found via search, e.g. https://learn.microsoft.com/en-my/answers/questions/254210/ and https://support.activenav.com/configuring-ad-azure-for-teams

## 9. Ready-to-send: what we're asking UT IT for

> Hi! Longhorn Sim Racing (a registered student org) is building a read-only assistant for our officers. We want the narrowest possible access to **our own team only**. Here is exactly what we're asking for:
>
> 1. **An app registration in UT's Entra tenant** named "LSR Jack (Longhorn Sim Racing)". It would be app-only (no user sign-in), with a client secret or certificate shared with our tech lead (Gray Marshall). If you'd rather create it yourselves, we just need the client ID and the credential.
> 2. **One Microsoft Graph permission with admin consent: `Sites.Selected` (Application).** On its own this grants access to nothing.
> 3. **Read access to our team's SharePoint site only.** Please run `POST https://graph.microsoft.com/v1.0/sites/{our-site-id}/permissions` with `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<app id>","displayName":"LSR Jack"}}]}`, or the PnP equivalent. Our site is `<site URL>`. If our team has private or shared channels we use, we'd need the same `read` grant on each of their sites. We can revoke or narrow this whenever you like.
> 4. **Permission to install our custom Teams app** in our team (`<team name>`) only. It requests one resource-specific permission, `ChannelMessage.Read.Group` (read this team's channel messages), which our team owner approves when installing. Either upload our app package to the org catalog and allow it for our team, or let our team owner upload custom apps. Please also confirm the team RSC consent setting isn't `DisabledForAllApps`.
> 5. **Posting:** we'd like to post the assistant's weekly digest to one channel, using either a Workflows (Power Automate) "Post to a channel when a webhook request is received" flow, or a single-tenant Azure bot tied to the same app. Which of the two does UT allow?
> 6. **Meeting transcripts (optional; tell us if it's a no):** reading our channel meeting transcripts would need `OnlineMeetingTranscript.Read.All` and `OnlineMeetings.Read.All`, an application access policy granted **only** to our officers' accounts, and turning on "Transcript API access → Microsoft Graph access". We understand that toggle is tenant-wide. If that's too broad, we'll have officers save transcripts to our SharePoint folder by hand instead, and we won't need anything extra.
> 7. **Two policy questions:** does UT's data classification allow us to keep a text copy of our team's messages and files in our club database, which only officers can see? And does UT require a protected-API or app review for any of the above?
>
> We are **not** asking for Files.Read.All, Sites.Read.All, ChannelMessage.Read.All, Group.Read.All, or any write permission to UT data. Thank you!

## 10. Checked

Second pass on 2026-10-22 against learn.microsoft.com (plus the Azure Bot pricing page and the PnP cmdlet page).

**Verified as written:**
- Token endpoint, form fields, `expires_in: 3599`, no refresh token in client credentials.
- `Sites.Selected` three-step model, `POST /sites/{id}/permissions` (needs `Sites.FullControl.All`; delegated callers need SharePoint Administrator and site membership), 201 with `grantedToIdentitiesV2`, the four roles, and `DELETE` to revoke.
- RSC manifest keys, `Set-MgBetaTeamRscConfiguration` states, the same-tenant sideload error, the 1:1 Teams-app-to-Entra-app rule, `GET /beta/teams/{id}/permissionGrants`, and the custom-app upload settings (team owners can upload when the team setting is off and their policy allows it).
- Channel messages: permissions (`ChannelMessage.Read.Group` for list, get, and replies), page size 20/max 50, reply-chain sort order, tenant rule, `Prefer: include-unknown-enum-members`, and `getAllMessages` needing `ChannelMessage.Read.All`.
- Drive APIs: children (200-item default page), delta (`token=latest`, timestamp tokens on SharePoint/ODB only, 410 resync codes with `Location`, track by `id`, last occurrence wins), `/content` 302 to a pre-authenticated URL with no auth header, `Range` on the download URL (206), `If-None-Match` (304), the 2 MB conversion cap with `Files.ReadWrite.All`, and drive search rejecting `Sites.Selected`.
- Subscriptions and webhooks: 4,320-minute chatMessage lifetime, about 30 days for driveItem, the `lifecycleNotificationUrl` rule, 409 duplicates, the 10 s validation echo (lifecycle URL too), 2xx within 3 s, retries for up to 4 hours, the slow/drop thresholds, `clientState` (128 characters max), and the 10-minute reauthorize/PATCH rule.
- Teams throttling rows, the four dimensions and the about-83% sustained limit, 500 subscription writes per 20 s, 130,000 per 10 s per app, the once-a-day polling rule, and Teams APIs unmetered since 2025-08-25.
- Transcripts: RSC only for private chat meetings, the access policy cmdlets with up to 30 minutes to apply, the exact missing-policy error, the tenant toggle and its cmdlet (off by default), the attribution toggle (off by default), the `JoinWebUrl` lookup (`OnlineMeetings.Read.All`, URL-encoded), the VTT and unattributed formats, the 403 codes, docx deprecated 2023-05-31, and the meeting-expiry limit.
- Posting: the post API only allows app permissions for migration, `ChannelMessage.Send.Group` exists in the RSC list, the Workflows trigger body and "Anyone" no-header rule, the 28 KB limit, private channels unsupported, orphaned flows, and the 4,500 invokes per 5 minutes.
- Bot: tenant-specific token endpoint and scope, the channel `v3/conversations` call returning `{id, activityId}`, the `PUT` update, 403 `MessageWritesBlocked`, the global service URL, inbound JWT checks (issuer, audience, RS256, 5-minute skew, `serviceUrl` claim, keys refreshed at least every 24 hours), receiving all channel messages with `ChannelMessage.Read.Group`, no new multi-tenant bots after 2025-07-31, and F0 with unlimited standard-channel messages (Teams counts as standard).
- The protected-API page still returns 404.

**Corrected:**
- `$expand=replies`: the parameter table says 200 replies per page, not 1,000 (the page's own example says 1,000).
- `missed` lifecycle events are documented for Outlook resources only, not chatMessage. Section 4 and the fake now say so, and the daily reconcile is the safety net.
- Added: subscriptions have a 45-minute minimum, `lifecycleNotificationUrl` can't be added by PATCH, and the reauthorize call has its own limit (1,000 per 20 s).
- Transcripts: the unattributed format is `Accept`-only, and `text/vtt` fails until attribution is turned on. Added the calendar-event limitation and updated the doc-conflict note.
- RSC manifest version: the `authorization` format needs v1.12+, and application RSC itself works from v1.6. Noted that the docs disagree on owner versus member consent.
- PnP cmdlet renamed to `Grant-PnPEntraIDAppSitePermission`. Added the finer `*.SelectedOperations.Selected` scopes, the cert `client_assertion_type`, and the Flow bot posting limit (25 per 300 s per connection).

**Resolved from UNVERIFIED:**
- `ChannelSettings.Read.Group` covers `GET /channels`.
- SharePoint throttling numbers are now filled in.
- PnP grant cmdlet.
- `/search/query` doesn't list `Sites.Selected`, so treat it as unsupported.

**Still UNVERIFIED:**
- How RSC is checked at call time.
- `Sites.Selected` on the site-by-path lookup, children, and delta.
- The `utexas.sharepoint.com` hostname.
- Conversion under `Sites.Selected`.
- The channel-message delta endpoint and its options (no REST page; the 8-month window is from chats).
- The reply resource format in notifications.
- `ChannelMessage.Send.Group` on the post API.
- The Workflows response code and "Any user in my tenant" token claims.
- The beta-versus-v1.0 conflict on channel-meeting transcripts.
- Whether RSC covers private and shared channels.
- `File.Read.Group` on `filesFolder`.
- Cross-directory Azure subscriptions for the bot.
- UT retention and data-classification policy, and whether UT allows Workflows.
