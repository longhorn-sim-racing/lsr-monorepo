# Research: Vercel Blob client uploads into a private store (10/22)

Spec for browser-to-Blob uploads with `@vercel/blob` 2.8.x (installed: **2.8.2**). Sources are Vercel's docs (fetched 10/22, pages dated Aug–Sep 2026) and the SDK's own `dist/` code in `apps/platform/node_modules/@vercel/blob`. Wire details marked "SDK wire" come from reading that code: they are what 2.8.2 sends, not a documented public REST contract (`x-api-version: 13`). Anything marked **UNVERIFIED** could not be confirmed from a primary source.

## 1. What we'd use it for
Officers (and later Jack's tools) attach files (event photos, sponsor logos, PDFs, short clips) from the admin UI straight into the **existing private Blob store** that already holds Jack's deck renders (`src/server/jack/decks/storage.ts`, connected with OIDC via `BLOB_STORE_ID`). Client uploads skip our functions, so files above the 4.5 MB function body limit work and cost no Fast Data Transfer. Everything stays private: reads go through role-checked routes with `get()`, or through short-lived signed links. One deliberate exception is the Instagram publisher, which needs a public JPEG URL for a few minutes. It gets a time-limited signed URL, or a proxy route as a fallback. No money moves, and nothing runs as a server process. Upload completion is confirmed by a normal request from the browser or by the Blob webhook callback.

## 2. Auth and setup
- **Store:** already created and private. A store's access mode (and region) **cannot be changed after creation**, so no blob in it can be made public.
  - Private storage needs SDK ≥ 2.3. Signed URLs arrived in 2.4.0 (changelog, 2026-06-02). We're on 2.8.2.
- **Credentials. There are no scopes and no read-only key type:**
  | Credential | What it is | Needed for |
  |---|---|---|
  | `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN` | OIDC, the default. The token is short-lived and rotated by Vercel. Locally, `vercel env pull` fetches it: the dev token lasts 12 h and the SDK refreshes it with the CLI login | Everything **except** `handleUpload` |
  | `BLOB_READ_WRITE_TOKEN` | Long-lived, full read/write on the whole store. Format `vercel_blob_rw_<storeId>_<secret>` | `handleUpload` (signs client tokens; **OIDC is not accepted**) and code running off Vercel |
  | `BLOB_WEBHOOK_PUBLIC_KEY` | Public Ed25519 key, PEM/SPKI. Not a secret | `handleUploadPresigned`. Existing store connections must opt in from the store's connection menu |
  | Client token `vercel_blob_client_<storeId>_<b64>` | Made by our server from the RW token. Scoped to 1 pathname until `validUntil`. The docs call it "single-use", but the payload has no nonce and multipart reuses it for create/parts/complete, so whether Blob rejects a second PUT is **UNVERIFIED**; keep `validUntil` short. **Defaults to 1 h in `handleUpload`** (30 s if you call `generateClientTokenFromReadWriteToken` directly) | The browser upload |
  | Signed token (`issueSignedToken`) | `{delegationToken (public), clientSigningToken (secret), validUntil}`. Scoped to a pathname (or `*`) and ops `get`/`head`/`put`/`delete`. Defaults to 1 h, **max 7 days** | Presigned GET/PUT URLs; the only read-only-style credential |
- **SDK credential order:**
  1. An explicit `token` option.
  2. OIDC (`oidcToken`/`VERCEL_OIDC_TOKEN` + `storeId`/`BLOB_STORE_ID`).
  3. `BLOB_READ_WRITE_TOKEN`.
  4. Otherwise it throws.

  If `BLOB_READ_WRITE_TOKEN` is set, OIDC still wins for every call except `handleUpload`.
- **Narrowest setup:** use **`handleUploadPresigned` + `uploadPresigned`**. This flow works on OIDC, so the long-lived RW token never has to exist in our env. Grant `operations: ['put']` scoped to the exact pathname, add `allowedContentTypes` and `maximumSizeInBytes`, and set `validUntil` to about 10 min.
  - The classic `handleUpload` flow (below) works too, but it needs `BLOB_READ_WRITE_TOKEN` in Production and Preview.
  - **Gotcha (SDK code):** `handleUploadPresigned` throws `Missing webhook public key` on *every* call, including URL generation, when `BLOB_WEBHOOK_PUBLIC_KEY` is unset.
- **Env vars:**
  - Required: `BLOB_STORE_ID` (have it). Plus either `BLOB_WEBHOOK_PUBLIC_KEY` (presigned flow) or `BLOB_READ_WRITE_TOKEN` (classic flow).
  - Local only: `VERCEL_BLOB_CALLBACK_URL` (tunnel base URL), `VERCEL_BLOB_API_URL` and `NEXT_PUBLIC_VERCEL_BLOB_API_URL` (point the server and the browser at the fake), `VERCEL_BLOB_RETRIES=0` (tests), `DEBUG=blob`.
  - Never `NEXT_PUBLIC_` a token.

### The classic flow (`upload()` + `handleUpload()`)
1. **Token request.** The browser calls `upload(pathname, file, { access: 'private', handleUploadUrl, clientPayload?, contentType?, multipart?, onUploadProgress? })`. This POSTs `blob.generate-client-token` to our route.
   - `upload()` **rejects** `addRandomSuffix`, `allowOverwrite`, `cacheControlMaxAge` and `ifMatch`. Only the server sets these.
2. **Our route checks the user.** It calls `handleUpload({ body, request, onBeforeGenerateToken, onUploadCompleted, token? })`.
   - `onBeforeGenerateToken(pathname, clientPayload, multipart)` must authenticate. It returns `{ allowedContentTypes?, maximumSizeInBytes? (≤5 TB), validUntil?, addRandomSuffix?, allowOverwrite?, cacheControlMaxAge? (≥60 s, default 1 month), ifMatch?, tokenPayload?, callbackUrl? }`. Throw to refuse.
3. **The SDK signs a token.** It HMAC-SHA256-signs `base64(JSON({pathname, allowedContentTypes, …, validUntil, onUploadCompleted:{callbackUrl, tokenPayload}}))` with the RW token, so the browser can't tamper with it. The browser *can* base64-decode and read it, though, so **`tokenPayload` is visible to the user**.
4. **The browser uploads straight to Blob,** with the token as Bearer.
5. **Blob calls back.** If a callback URL was resolved, Blob POSTs `blob.upload-completed` to the same route. `handleUpload` verifies the signature and runs `onUploadCompleted({ blob, tokenPayload })`.
- **`tokenPayload` defaults to `clientPayload`** (SDK code: `payload.tokenPayload ?? clientPayload`). Always set it on the server from the session; otherwise the client controls what the callback trusts.
- **Why `onUploadCompleted` doesn't fire on localhost:**
  - `getCallbackUrl()` only produces a URL when `VERCEL_BLOB_CALLBACK_URL` is set, or when `VERCEL === "1"`. On Vercel it uses `VERCEL_BRANCH_URL` (or `VERCEL_URL`) on previews and `VERCEL_PROJECT_PRODUCTION_URL` on production.
  - Locally there's neither, so the token carries **no callback at all**, and the SDK only logs a warning.
  - Even with one, Blob can't reach `localhost`. Use a tunnel (ngrok) and set `VERCEL_BLOB_CALLBACK_URL=https://<tunnel>`.
  - Docs: "Use tools like ngrok if you want this to work locally".

## 3. Endpoints we need
Our two routes, then the Blob calls the SDK makes ("SDK wire"; default API base `https://vercel.com/api/blob`). Errors from Blob come back as `{"error":{"code","message"}}`. The SDK maps codes to classes:
- `forbidden` → `BlobAccessError`
- `not_found` → `BlobNotFoundError`
- `store_not_found` → `BlobStoreNotFoundError`, `store_suspended` → `BlobStoreSuspendedError`
- `bad_request` → plain `BlobError` carrying the server message
- `rate_limited` → `BlobServiceRateLimited` (reads `retry-after`)
- `precondition_failed` → `BlobPreconditionFailedError`
- `content_type_not_allowed`, `client_token_pathname_mismatch`, `client_token_expired` (message `Token expired`), `file_too_large` (message contains `the file length cannot be greater than`), `oidc_environment_not_allowed`
- `client_token_not_allowed`
- `service_unavailable`/`unknown_error`/`internal_server_error`, network errors, and any error body that isn't JSON → **retried up to `VERCEL_BLOB_RETRIES` (default 10)**. Everything else (including `rate_limited`) fails at once.
- `get()` doesn't use this path: it's a plain `fetch` with no retries, `null` on 404, and a generic `Failed to fetch blob: <status>` otherwise.

**A. Our upload route** `POST /api/admin/jack/uploads` (name TBD). It handles both event types on one URL.
```jsonc
// browser → us (token request). Same shape with type "blob.generate-presigned-url" for the presigned flow
{"type":"blob.generate-client-token","payload":{"pathname":"jack/uploads/u_123/photo.jpg","clientPayload":"{\"roomId\":\"r1\"}","multipart":false}}
// us → browser
{"type":"blob.generate-client-token","clientToken":"vercel_blob_client_abc123_ZjNhOS4uLmV5SndZWFJv..."}
// presigned flow reply instead:
{"type":"blob.generate-presigned-url","presignedUrlPayload":{"delegationToken":"eyJ…","signature":"Qm9…","params":{"vercel-blob-allowed-content-types":"image/jpeg,image/png","vercel-blob-maximum-size-in-bytes":"26214400","vercel-blob-add-random-suffix":"true","vercel-blob-valid-until":"1761150600000"}}}
```
- **Status codes:** any non-2xx makes the browser throw `Vercel Blob: Failed to  retrieve the client token` (presigned flow: `Vercel Blob: Failed to retrieve the presigned URL`), and our error text is **not** shown to the user. Return 401/403 for auth, 400 for bad input.
- **The callback can't carry a session.** Blob's POST has no cookies, so check auth **inside `onBeforeGenerateToken`/`getSignedToken` only**, never at the top of the route. Docs: "The webhook will retry 5 times waiting for a 200".

**B. Upload (browser → Blob)**, sent by `upload()`/`uploadPresigned()`.
- Request: `PUT {api}/?pathname=<enc>`, or the presigned form `…&<params>&vercel-blob-delegation=…&vercel-blob-signature=…`.
- Headers:
  - Classic flow only: `authorization: Bearer <client token>`. The presigned flow sends no Authorization header.
  - `x-api-version: 13`, `x-vercel-blob-store-id`, `x-api-blob-request-id`, `x-api-blob-request-attempt`.
  - `x-vercel-blob-access: private`, and `x-content-type` only if `contentType` was passed.
  - `x-content-length` (sent with progress).
```json
{"url":"https://abc123.private.blob.vercel-storage.com/jack/uploads/u_123/photo-oYnXSVczoLa9yBYMFJOSNdaiiervF5.jpg",
 "downloadUrl":"https://abc123.private.blob.vercel-storage.com/jack/uploads/u_123/photo-oYnX….jpg?download=1",
 "pathname":"jack/uploads/u_123/photo-oYnXSVczoLa9yBYMFJOSNdaiiervF5.jpg","contentType":"image/jpeg",
 "contentDisposition":"attachment; filename=\"photo-oYnX….jpg\"","etag":"\"a1b2c3d4e5f6\""}
```
- **Random suffix:** with `addRandomSuffix: true`, the stored pathname differs from the requested one (`-<30 chars>` before the extension). Store `blob.pathname`, not the requested name.
- **Overwrites:** without `allowOverwrite`, a duplicate pathname fails (docs: "the upload fails with an error"). The exact code and message are **UNVERIFIED**: neither the docs nor the SDK changelog name them, and the SDK has no dedicated class, so it will surface as a plain `BlobError` or `BlobUnknownError`.
- **Errors to handle:** expired token, wrong type, too large, pathname mismatch, rate limit.

**C. Multipart** (`multipart: true`). The SDK does it automatically:
- `POST {api}/mpu?pathname=` with `x-mpu-action: create` → `{key, uploadId}`.
- `x-mpu-action: upload` + `x-mpu-key` (URI-encoded) + `x-mpu-upload-id` + `x-mpu-part-number` → `{etag, partNumber}`.
- `x-mpu-action: complete`, with a JSON array of parts in the body → `PutBlobResult`.
- **Part sizing:** SDK parts are **8 MiB**, with 6 in flight in a browser (8 in Node). Manual parts must be ≥5 MB except the last, and all of equal size.
- **When to use it:** the docs recommend it above 100 MB. A multipart upload costs one Advanced Op to start, one per part, and one to complete, so keep images on a single PUT.

**D. Callback (Blob → us)**: `POST <callbackUrl>` (our route plus its query string).
```json
{"type":"blob.upload-completed","payload":{"blob":{"url":"…","downloadUrl":"…","pathname":"…","contentType":"image/jpeg","contentDisposition":"…","etag":"\"a1b2c3d4e5f6\""},"tokenPayload":"{\"userId\":\"u_123\"}"}}
```
- **Signature (classic flow):** header `x-vercel-signature` = **hex HMAC-SHA256 of `JSON.stringify(parsedBody)`**, keyed with `BLOB_READ_WRITE_TOKEN`. It's checked against the *re-serialized* parsed body, not the raw bytes, so pass `await request.json()` through untouched.
- **Signature (presigned flow):** the same header carries an **Ed25519 signature, 128 hex chars**, over the same string. It's verified with the `BLOB_WEBHOOK_PUBLIC_KEY` PEM.
- **Reply:** `{"type":"blob.upload-completed","response":"ok"}`.
- **Payload fields:** the docs say `blob` has the shape of `put()`'s result, and the SDK types it as `PutBlobResult` (`url, downloadUrl, pathname, contentType, contentDisposition, etag`). So `etag` is included and **`size` is not**. Call `head()` for the size.

**E. Reads**
- **`get(pathnameOrUrl, { access:'private', ifNoneMatch?, useCache? })`**
  - The SDK GETs `https://<storeId>.private.blob.vercel-storage.com/<pathname>` with `authorization: Bearer <OIDC|RW>`. `useCache:false` adds `?cache=0`, a consistent read that bypasses the up-to-60 s CDN staleness.
  - Returns `null` on 404. Otherwise `{statusCode:200|304, stream|null, headers, blob:{url, downloadUrl, pathname, contentType, contentDisposition, cacheControl, etag, size, uploadedAt}}`.
  - Serve it from a role-checked route with `Cache-Control: private, no-cache` (or `no-store` for PII) and `X-Content-Type-Options: nosniff`. Don't use `s-maxage`.
  - A function response is capped at 4.5 MB. Above that, redirect to a signed URL, as `decks/storage.ts` already does.
- **`head(urlOrPathname)`**: `GET {api}?url=…` (no slash before `?`, unlike the PUT's `{api}/?pathname=`) returns `{url, downloadUrl, pathname, size, contentType, contentDisposition, cacheControl, uploadedAt, etag}`. Costs one Simple Op.
- **`list({prefix, limit, cursor, mode})`**: `GET {api}?prefix=…` (limit defaults to 1000) returns `{blobs:[{url,downloadUrl,pathname,size,uploadedAt,etag}], cursor, hasMore, folders?}`. Paginate on `cursor`/`hasMore`. Sorted lexicographically. Costs one Advanced Op.
- **`del(urls)`**: `POST {api}/delete {"urls":[…]}`. Free to bill, but each URL counts as one Advanced Op toward the **rate limit**.

**F. Signed URLs (third-party reads)**
- `issueSignedToken({ pathname, operations:['get'], validUntil })` sends `POST {api}/signed-token` and returns `{delegationToken, clientSigningToken, validUntil}`. The docs say to cache the token and reuse it until it nears expiry.
- `presignUrl(token, { operation:'get', pathname, access:'private', validUntil?, useCache? })` is async but local HMAC only (no network). It returns `{ presignedUrl }`, where `presignedUrl` is `https://<storeId>.private.blob.vercel-storage.com/<pathname>?[vercel-blob-valid-until=<ms>&]vercel-blob-delegation=<token>&vercel-blob-signature=<b64url>`.
  - `vercel-blob-valid-until` only appears when the URL's expiry is earlier than the delegation's. The URL's expiry is capped at the delegation's.
  - The signature is base64url HMAC-SHA256 (key `clientSigningToken`) of the lines `operation=get`, `pathname=…` and any `vercel-blob-*=…`, sorted by UTF-8 bytes and joined with `\n`.
  - Docs use case: "Share a private blob with a third party for a limited window".

## 4. Webhooks/events
- **The only event** is `blob.upload-completed` (§3D). There are no delete or other events.
- **Retries:** at-least-once, with up to 5 retries until a 200. So `onUploadCompleted` must be **idempotent**: upsert on `pathname`.
- **Timeout:** the callback timeout is **UNVERIFIED**. No Vercel page or SDK code states it, and the retry count only appears in a docs code comment ("The webhook will retry 5 times waiting for a 200"). Keep the handler fast.
- **Don't rely on it for correctness.** It's absent locally, it races the browser's own next request, and on previews it targets `VERCEL_BRANCH_URL`. Our previews sit behind Vercel Authentication, so the callback probably gets a 401 there (**UNVERIFIED**, not tested).
  - Vercel documents `?x-vercel-protection-bypass=<secret>` as the way to let header-less webhooks through (all plans). It isn't tested with Blob callbacks.
  - **Don't do it anyway.** The `callbackUrl` is readable in the client token, and it sits in plain text in the presigned query (`vercel-blob-callback-url`). That would hand a project-wide bypass secret to the browser.
- **Recommended pattern:** after `upload()` resolves, the browser calls a Server Action with `blob.pathname`. The server then:
  1. checks the pathname is under the prefix it issued (`jack/uploads/<userId>/`);
  2. calls `head()` to confirm the size and type;
  3. writes the DB row and an `AuditLog` entry.

  The callback, where it fires, upserts the same row.

## 5. Rate limits, quotas, retention
- **Hobby included per month**, shared across the project's services:
  - 1 GB storage (monthly average of 15-min snapshots)
  - **10,000 Simple Ops**: cache-MISS reads and `head`
  - **2,000 Advanced Ops**: every upload, multipart part, copy and `list`. **Dashboard browsing counts too.**
  - 10 GB Blob Data Transfer
- **Over the limits:** "you will not be able to access Vercel Blob if limits are exceeded… wait until 30 days". That's a hard outage, not a bill. Jack's deck renders share this budget.
- **Rate limits (Hobby):** 1,200 Simple Ops/min (20/s) and **900 Advanced Ops/min (15/s)**. Counted per operation: `del` of 100 URLs = 100.
- **Size limits:**
  - 5 TB per blob (`maximumSizeInBytes` cap).
  - Blobs over 512 MB are never CDN-cached.
  - Pathname ≤950 chars, with no `//` and no control characters.
- **Function limits:** 4.5 MB function request/response body. Hobby functions run 300 s max.
- **Pricing:** client uploads have no transfer charge. Private delivery through a function costs Blob Data Transfer + Fast Origin Transfer (on a miss) for the function's fetch, plus Fast Data Transfer + Fast Origin Transfer for the function's response. Deletes are free.
- **Retention:** blobs live until deleted. None of the Blob docs pages (overview, SDK, pricing, examples) mention a TTL or lifecycle rule, and a Vercel community thread says there isn't one. The official examples page shows a `list` + `del` batch script to run as a Cron Job instead. Plan a scheduled cleanup (pg_cron → a route that `list`s a prefix and `del`s old files), and keep it in budget: each `list` page is an Advanced Op.
- **Durability:** S3-backed, 11 nines durability and 99.99% availability. AES-256 at rest.

## 6. Gotchas, policy and privacy
1. **Auth lives in the callbacks, not the route.** Without the check in `onBeforeGenerateToken`/`getSignedToken`, anyone can upload. Also pin the pathname: reject unless it starts with `jack/uploads/<session userId>/`, and force `addRandomSuffix: true`.
   - Also reject `.`/`..` segments. API version 13 (SDK 2.8.2) stores such keys literally, without normalizing them, so they can't escape the prefix on Blob's side. They would still confuse our own routes and DB.
2. **`allowedContentTypes` checks the declared type** (`x-content-type`, or the type inferred from the extension), not the bytes. The signed-URL docs describe the check as rejecting "requests whose `Content-Type` header is not in the list". No doc mentions content sniffing, so whether any happens is **UNVERIFIED**; assume none.
   - Pass `contentType: file.type` explicitly.
   - Re-check magic bytes server-side before using a file (especially before handing it to Instagram).
   - Wildcards like `image/*` are allowed.
3. **Token contents are readable by the user.** The client token, `tokenPayload`, presigned `params` and `callbackUrl` can all be base64-decoded by the browser. Put IDs there, never secrets or emails.
4. **The `access` value has to match the store:** always `'private'` here. The server's error for a mismatched upload is **UNVERIFIED**. For `get()` by pathname, the SDK builds the host from `access` (`<storeId>.<access>.blob.vercel-storage.com`), so a wrong value hits the wrong host and may come back as a silent `null` (also **UNVERIFIED**).
5. **Overwriting is risky:** it propagates through the CDN in up to 60 s. Treat blobs as immutable (random suffix). Use `useCache:false` only when reading right after an overwrite.
6. **`get()` doesn't know about the fake.** `get()`, and `presignUrl()` for `get`/`head`, build the store host (`*.blob.vercel-storage.com`) from the store ID and **ignore `VERCEL_BLOB_API_URL`**. `get()` follows the override only when given a full URL whose origin equals the override's (`isAllowedBlobUrl`). Presigned `put`/`delete` URLs do use the API URL, so they honor the override.
7. **Docs and types disagree on `onUploadCompleted`.** The docs table marks it required for `handleUpload`, but the types make it optional. Omit it and the SDK won't work out a callback URL. If you return `callbackUrl` yourself, though, it still goes into the token (with a console warning), and Blob will call a route that ignores it.
8. **Privacy:** member photos and uploads hold personal data. Keep the store private, gate every read route with `requireOfficer()`, and log admin uploads.
   - The Hobby plan "restricts users to non-commercial, personal use only" (Hobby plan page, citing the fair-use guidelines). Whether club use fits is **UNVERIFIED** and is a board/billing question, not a Blob one.
9. **Firewall:** a WAF "Challenge" rule on the store makes SDK traffic fail with 429.

### Making a private blob temporarily fetchable (Instagram)
- **What Instagram needs:** Meta's content-publishing docs say `image_url` must be "on a public server" because "We will cURL your image", at container-creation time. **JPEG is the only image format.** No max size or retention window is stated for images. Jack already renders a full-size JPEG.
- **Option 1, recommended: a presigned GET URL** for that one pathname, `validUntil` ≈ 1 h (max 7 days).
  - We already have `jackFileStore().signedUrl()`.
  - It works without making anything public, and it expires on its own.
  - **UNVERIFIED:** whether Meta's fetcher accepts the long query string, and whether it sends a `HEAD` first. A `get`-signed URL **cannot** be replayed as `HEAD`, because ops are signed separately.
- **Option 2, fallback: a proxy route on our domain,** e.g. `GET`/`HEAD /api/jack/media/<id>?exp=…&sig=…`, with our own HMAC (a server secret) and a DB row that can be revoked.
  - It `get()`s the blob and streams it back with `Content-Type: image/jpeg`.
  - It handles HEAD explicitly, so export `HEAD` from the route.
  - Cost: function time + Fast Data Transfer. It stays under 4.5 MB if images are kept small.
- **Option 3: put a copy in a second, *public* store** under a random-suffix name, then `del` it once the IG container is `FINISHED`.
  - It needs a second store and passing `storeId` explicitly.
  - `copy()` won't do it: the docs define it as copying "to a new path inside the blob store". Use `get()` + `put()` with the second store's `storeId`.
  - The file is world-readable while it lives, so this is the least preferred.

## 7. How to fake it locally
- **There's no official full emulator.** `vercel-labs/emulate` serves `put`/`head`/`list`/`del` at `VERCEL_BLOB_API_URL=http://localhost:4000/api/blob`, with any token shaped `vercel_blob_rw_<storeId>_<secret>`. But it says "Client (browser) uploads are not supported yet", multipart parts/complete return 400, and it doesn't mention signed URLs. So we write our own fake.
- **Unit tests (Vitest, no network):**
  - `handleUpload`'s token step is **pure local crypto**. Set `BLOB_READ_WRITE_TOKEN=vercel_blob_rw_fakestore_secret` and call the real route with a `blob.generate-client-token` body.
  - Decode the result with `getPayloadFromClientToken()` and assert on `pathname`, `allowedContentTypes`, `maximumSizeInBytes`, `tokenPayload` and `validUntil`.
  - Test callbacks by signing `JSON.stringify(body)` with HMAC-SHA256 hex under the same fake token.
  - For the presigned flow, mock `issueSignedToken`; `presign` is local.
  - Keep the `JackFileStore` interface and `setJackFileStore()` for everything that reads.
- **Local end-to-end fake server** (Node `http`, e.g. port 4010).
  - **Wiring:**
    - Set `VERCEL_BLOB_API_URL=http://localhost:4010/api/blob` and `NEXT_PUBLIC_VERCEL_BLOB_API_URL` to the same value, for the browser.
    - The SDK reads `process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL` literally. Whether Next 16/Turbopack inlines that inside `node_modules` is **UNVERIFIED**; check it once in devtools.
  - **Endpoints and checks it must reproduce:**
    - **Auth:** accept `Bearer vercel_blob_rw_<id>_<s>` and `Bearer vercel_blob_client_<id>_<b64>`.
      - For client tokens, split off the base64 part, decode it to `<hexHmac>.<b64json>`, and verify `HMAC-SHA256(b64json, rwToken)`.
      - Enforce `pathname` equality (code `client_token_pathname_mismatch`) and `validUntil` (`Token expired`).
      - Enforce `allowedContentTypes`, wildcards included (message `contentType … is not allowed`), and `maximumSizeInBytes` (`the file length cannot be greater than N`).
      - Enforce `allowOverwrite` and `addRandomSuffix` (`-` + 30 alphanumerics before the extension).
    - **Routes:** `PUT /api/blob/?pathname=`, `POST /api/blob/mpu` (create/upload/complete via the `x-mpu-*` headers), `GET /api/blob?url=` (head), `GET /api/blob?prefix=` (list with `cursor`/`hasMore`), `POST /api/blob/delete`, and `POST /api/blob/signed-token`. The SDK sends head/list **without** the trailing slash, so match `/api/blob` and `/api/blob/` alike.
      - **`signed-token`:** mint `delegationToken = b64url(JSON{storeId,pathname,operations,validUntil,…}).<sig>` plus a random `clientSigningToken`, and remember the pair.
      - **Presigned PUT/GET:** recompute the canonical string and check `vercel-blob-signature`.
    - **Content:** `GET http://localhost:4010/<pathname>` (same origin as the override, so `get(url)` is allowed). Require a Bearer token or a valid presigned query, and honor `If-None-Match` → 304.
      - Return `url`s on this origin. **`get()` by bare pathname will still hit the real host** (Gotcha 6).
    - **Responses:** `PutBlobResult` JSON exactly as in §3B. Errors go out as `{"error":{"code","message"}}` with the matching status (403/404/400/412/429 plus `retry-after`).
    - **Callbacks:** after a PUT whose token carries `onUploadCompleted.callbackUrl`, POST the §3D body with `x-vercel-signature` = hex HMAC of the compact JSON. Retry up to 5 times on a non-200. Optionally also send an Ed25519 signature from a local key pair for the presigned flow.
    - **CORS:** the browser PUTs cross-origin.
      - Answer `OPTIONS` with `Access-Control-Allow-Origin: http://localhost:3000` and `Allow-Methods: GET, HEAD, PUT, POST, DELETE`.
      - `Allow-Headers` must list: `authorization, content-type, x-api-version, x-api-blob-request-id, x-api-blob-request-attempt, x-vercel-blob-store-id, x-vercel-blob-access, x-content-type, x-content-length, x-add-random-suffix, x-allow-overwrite, x-cache-control-max-age, x-if-match, x-mpu-action, x-mpu-key, x-mpu-upload-id, x-mpu-part-number`.
- **Fault injection:** expired token, wrong type, too large, 429 with `retry-after`, 503 (watch the SDK retry), and a callback that 500s twice before succeeding.
- **Without a fake:** `vercel env pull` + `BLOB_STORE_ID` runs against a real store; use a separate dev store, since Hobby ops are shared. `fileStore` (`.jack-renders/`) covers server-side reads and writes.

## 8. Sources
- https://vercel.com/docs/vercel-blob/client-upload
- https://vercel.com/docs/vercel-blob/private-storage
- https://vercel.com/docs/vercel-blob/vercel-signed-urls
- https://vercel.com/docs/vercel-blob/using-blob-sdk
- https://vercel.com/docs/vercel-blob
- https://vercel.com/docs/vercel-blob/usage-and-pricing
- https://vercel.com/docs/vercel-blob/server-upload
- https://vercel.com/docs/vercel-blob/security
- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/vercel-blob/examples
- https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
- https://vercel.com/changelog/signed-urls-are-now-available-for-vercel-blob
- https://github.com/vercel/storage/blob/main/packages/blob/CHANGELOG.md
- https://community.vercel.com/t/vercel-blob-expiry-ttl-possible-workaround/17650 (community, not official)
- https://developers.facebook.com/docs/instagram-platform/content-publishing/
- https://cdn.jsdelivr.net/gh/vercel-labs/emulate@main/README.md (vercel-labs/emulate)
- `@vercel/blob@2.8.2` source: `apps/platform/node_modules/@vercel/blob/dist/{client.js,client.d.ts,index.js,chunk-XKVPKJPO.js,create-folder-BM6BTlko.d.ts}`
- Repo context: `apps/platform/src/server/jack/decks/storage.ts`, `docs/jack.md`

## 9. Checked (10/22, second pass)
I re-fetched the Vercel docs (client-upload, using-blob-sdk, vercel-signed-urls, private-storage, vercel-blob, usage-and-pricing, security, examples, plans/hobby, functions/limitations, protection-bypass-automation), the signed-URLs changelog, the SDK CHANGELOG, Meta's content-publishing page and the emulate README, and re-read `@vercel/blob@2.8.2` `dist/`.

**Confirmed as written:**
- **Auth and credentials**
  - The credential order: explicit `token` → OIDC + store id → `BLOB_READ_WRITE_TOKEN` → throw.
  - Dev OIDC tokens last 12 h and auto-refresh.
  - `handleUpload` needs the RW token and doesn't accept OIDC. `handleUploadPresigned` works on OIDC and verifies with `BLOB_WEBHOOK_PUBLIC_KEY`; existing connections opt in from the connection menu.
  - The store's access mode and region are fixed at creation.
  - SDK versions: private storage needs ≥2.3; signed URLs and OIDC need ≥2.4.0 (changelog dated 2026-06-02).
- **Signed tokens:** default 1 h, max 7 days. Ops are `get`/`head`/`put`/`delete`, and `head` is signed separately from `get`.
- **Client tokens (SDK wire)**
  - Defaults: 1 h in `handleUpload`, 30 s when generated directly.
  - Token format and HMAC: `vercel_blob_client_<id>_b64(<hexHmac>.<b64json>)`.
  - `tokenPayload` falls back to `clientPayload`.
  - Callback URL resolution: `VERCEL_BLOB_CALLBACK_URL`, then `VERCEL=1` with `VERCEL_BRANCH_URL`/`VERCEL_URL`/`VERCEL_PROJECT_PRODUCTION_URL`.
- **Wire details (SDK):** `upload()` rejects the four server-only options, `x-api-version: 13`, the error-code map, and `Missing webhook public key` on every call.
- **Callback signatures:** hex HMAC of `JSON.stringify(body)` (classic), or Ed25519 / 128 hex / SPKI PEM (presigned).
- **Multipart and pathnames:** 8 MiB parts with 6/8 in flight, the ≥5 MB manual minimum, the 950-character pathname limit, `//` rejected, and the 30-character random suffix.
- **Plan limits and pricing**
  - Hobby includes 1 GB, 10k Simple Ops, 2k Advanced Ops and 10 GB transfer. Dashboard browsing counts as ops, and going over means the 30-day lockout.
  - Rate limits: 1,200 Simple and 900 Advanced Ops per minute. Each URL in a `del` counts as one op.
  - Size and caching: 5 TB max file, 512 MB cache limit, 100 MB multipart advice, 60 s propagation.
  - Platform: 11 nines durability, 99.99% availability, AES-256 at rest, and a WAF Challenge returns 429.
  - Functions: 4.5 MB body limit, and Hobby runs 300 s max.
- **Private reads:** `Cache-Control: private, no-cache` (`no-store` for PII) plus `nosniff`.
- **Meta:** a public server is required, "We will cURL your image", JPEG only.
- **Emulator:** the `emulate` README limits as stated.

**Corrected:**
- **Client token:** it isn't "1 PUT". Multipart reuses it, and whether it's single-use isn't verified.
- **Multipart billing:** start + each part + complete, not just one Advanced Op per part. Parts must also be equal size.
- **Callback `blob`:** it's `PutBlobResult`, so it includes `etag` and has no `size` (the §3D example now shows `etag`).
- **`head`/`list` paths:** they hit `{api}?…` with no trailing slash (§3E and the fake's routes in §7).
- **`presignUrl()`:** it returns `{ presignedUrl }`, and `vercel-blob-valid-until` only appears when the URL's expiry is shorter than the delegation's. Presigned `put`/`delete` honor `VERCEL_BLOB_API_URL`.
- **Retries:** they also cover `internal_server_error`, network errors and non-JSON error bodies. `get()` never retries.
- **Private delivery:** it also incurs Fast Origin Transfer on the function's response.
- **`onUploadCompleted` omitted:** a `callbackUrl` you return yourself is still embedded in the token.
- **Error classes:** added for `store_not_found`/`store_suspended`/`bad_request`, plus the presigned flow's token-fetch error message.

**Resolved (was UNVERIFIED):**
- **Callback payload fields:** `etag` yes, `size` no.
- **Cross-store `copy()`:** the docs say `copy()` stays inside the store, so use `get()` + `put()`.
- **TTL:** none is documented, and the community confirms there isn't one.
- **Preview bypass param:** the query-param bypass is documented, but it would leak the secret through `callbackUrl`, so don't use it.
- **Hobby wording:** the "non-commercial, personal use only" text is confirmed.

**Still UNVERIFIED:**
- The duplicate-pathname error code and message.
- The callback timeout.
- Whether client tokens are really single-use.
- Whether preview callbacks get a 401.
- Content sniffing.
- The server's error for an `access` mismatch.
- Whether club use fits Hobby (a board call).
- Whether Meta's fetcher accepts long signed query strings, and whether it sends `HEAD` first.
- Whether Next 16/Turbopack inlines `NEXT_PUBLIC_VERCEL_BLOB_API_URL` inside `node_modules`.
