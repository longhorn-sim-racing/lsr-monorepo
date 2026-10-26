# Anthropic tools for Jack 2.0: tool search, web search/fetch, files

Researched 2026-10-22 from platform.claude.com/docs (pages listed under Sources). Installed SDK: `@anthropic-ai/sdk@0.133.0`, which already types every block and tool below (`ToolSearchToolBm25_20251119`, `WebSearchTool20260209`, `WebFetchTool20260209`, `FileDocumentSource`, `client.files`). Anything marked **UNVERIFIED** was not stated in the docs I read.

## 1. What we'd use it for

Jack 2.0 adds many read-only data tools (Stripe, Resend, Vercel analytics, Instagram, Twitch, Drive, SharePoint, Discord, club DB). Sending every schema on every turn costs tokens and makes tool choice worse past about 30 to 50 tools. **Tool search** lets Jack keep a few tools always loaded and pull the rest in when needed, without breaking the prompt cache. **Web search/fetch** cover "look this up" questions (sponsor research, sim-racing news, a link an officer pastes) on Anthropic's servers, so there's nothing for us to host. **Files** let officers attach PDFs and images (sponsor decks, receipts, flyers, screenshots) for Jack, Lift or Stand to read. None of these move money. All are plain `POST /v1/messages` features that fit our serverless setup: Vercel functions, Supabase pg_cron + pg_net, webhooks.

Models: Jack = `claude-sonnet-5-5`, Lift = `claude-opus-5-5`, Stand = `claude-haiku-5-5`.

## 2. Auth and setup

- **Auth:** the existing `ANTHROPIC_API_KEY`. The docs now list `Authorization: Bearer <key>` as the main header and `x-api-key` as a legacy fallback that still works. SDK 0.133.0 sends `X-Api-Key` when it's given an API key, plus `anthropic-version: 2023-06-01`. A newer API version, `2026-10-21`, now exists. It's opt-in, and under it `temperature`/`top_p`/`top_k` and `document` blocks in assistant messages return a 400. Stay on `2023-06-01` (the SDK default) unless we migrate on purpose. **No beta header** is needed for anything in this doc: tool search, web search/fetch `_20260209`, Files API, PDFs, citations and code execution are all GA.
- **Narrowest scope:** API keys have no per-feature scopes. The real boundary is the **workspace** plus the key type. Uploaded files can be read by any key in the same workspace, so make a dedicated `jack` workspace and set a workspace spend limit (the Default workspace can't have one). Use a **service account key** scoped to that workspace, not a personal key. A personal key stops working, and is archived, when its owner leaves the org, which matters with student turnover. Workspace keys are legacy.
- **Console → Settings → Capabilities:** an org admin can turn web search and web fetch on or off and set org-wide allowed/blocked domain lists. If either is off, a request that includes it returns a `400 invalid_request_error`. A request's `allowed_domains` must be a subset of the org's allowed list, or the request gets a 400.
- **Token lifetimes:** an API key's expiration is chosen once, when it's created: a preset (3 hours, 1, 7 or 30 days), a custom length, or **Never**. It can't be changed later. An expired key returns `401 authentication_error` and can't be reactivated. Anthropic emails the key's creator before it expires (7 days ahead for keys that last at least 14 days). For the prod key, pick Never and rotate it ourselves, or record the expiry date. If we ever use Workload Identity Federation (WIF), the SDK refreshes those short-lived tokens itself. Files live until deleted or until `expires_at`.
- **Env vars:** `ANTHROPIC_API_KEY` (already set). Local fakes use `ANTHROPIC_BASE_URL`: the SDK reads it, or we pass `new Anthropic({ baseURL })`. Optional tuning knobs: `JACK_WEB_SEARCH_MAX_USES` and `JACK_WEB_FETCH_ALLOWED_DOMAINS` (our names, not Anthropic's).

## 3. Endpoints we need

All model calls go to `POST https://api.anthropic.com/v1/messages`. The tools are entries in `tools[]`.

### 3a. Tool search + `defer_loading`

| Item | Value |
|---|---|
| Types | `tool_search_tool_bm25_20251119` (name `tool_search_tool_bm25`, natural-language query, at most 500 chars) and `tool_search_tool_regex_20251119` (name `tool_search_tool_regex`, Python `re.search` pattern, case-insensitive, at most 200 chars). Undated aliases `tool_search_tool_bm25` and `tool_search_tool_regex` resolve to the latest version. |
| Models | **All three** (Opus 5.5, Sonnet 5.5, Haiku 5.5) support both variants, as do Haiku 4.5 and newer models. |
| Declaring | Send **every** tool's full definition on **every** request. Mark the ones to load on demand `"defer_loading": true`. Never defer the search tool itself. At least one tool must stay non-deferred. Keep the 3 to 5 most-used tools non-deferred. |
| What gets searched | Tool name, description, argument names, argument descriptions. Prefix names by service (`stripe_`, `discord_`) so one search matches the whole group. |
| Limits | At most 10,000 deferred tools per request. Each search returns 5 tools by default; the model can set `limit` from 1 to 10,000. |
| Price | Not metered. Discovered definitions count as ordinary input tokens. `usage.server_tool_use` has no tool-search field. |
| Caching | Deferred tools are stripped from the cached prefix. A discovered tool is expanded inline as a `tool_reference` in the message history, so **the cache survives discovery**. `cache_control` on a deferred tool returns a **400**; put the breakpoint on the last non-deferred tool. Strict-mode grammar is built from the full toolset, so `strict: true` works together with deferral. |
| Streaming | `server_tool_use` streams `input_json_delta` events. `tool_search_tool_result` arrives **complete in one `content_block_start`** event with no deltas. |
| Batches / ZDR | Works in Batches. ZDR-eligible. |

Request (trimmed, TS SDK):
```ts
tools: [
  { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
  { name: "club_sql", description: "...", input_schema: {...}, cache_control: { type: "ephemeral" } }, // non-deferred
  { name: "stripe_list_payments", description: "...", input_schema: {...}, defer_loading: true },
]
```
Response (trimmed):
```json
{"content":[
 {"type":"server_tool_use","id":"srvtoolu_01ABC","name":"tool_search_tool_bm25","input":{"query":"stripe payments refunds","limit":5}},
 {"type":"tool_search_tool_result","tool_use_id":"srvtoolu_01ABC",
  "content":{"type":"tool_search_tool_search_result","tool_references":[{"type":"tool_reference","tool_name":"stripe_list_payments"}]}},
 {"type":"tool_use","id":"toolu_01XYZ","name":"stripe_list_payments","input":{"limit":20}}
],"stop_reason":"tool_use"}
```
On the next request, send the assistant content back **unchanged** with the same `tools` array, and return a `tool_result` only for `toolu_…` IDs. **Never** return one for `srvtoolu_…`; the API rejects it. A search with no matches returns an empty `tool_references` array, not an error.

**Our own search (option for later):** a normal client tool can return `{"type":"tool_result","tool_use_id":"toolu_…","content":[{"type":"tool_reference","tool_name":"x"}]}`, and the API expands it the same way. Every referenced name must exist in `tools[]`.

**Errors:**
- HTTP 400 `"At least one tool must have defer_loading=false…"`.
- HTTP 400 `"Tool reference 'x' not found in available tools"`.
- HTTP 200 with `content.type: "tool_search_tool_result_error"` and `error_code` set to one of `invalid_tool_input`, `unavailable`, `too_many_requests` or `execution_time_exceeded`.

### 3b. Web search (`web_search_20260209`)

Versions: `web_search_20250305` (basic), `web_search_20260209` (adds dynamic filtering) and `web_search_20260318` (adds `response_inclusion`). Use `_20260209` as specced, or `_20260318` if we want `"response_inclusion":"excluded"` to drop nested raw results from the response and save output tokens.

```json
{"type":"web_search_20260209","name":"web_search","max_uses":5,
 "allowed_domains":["fia.com","iracing.com"],          // OR blocked_domains, never both (400)
 "user_location":{"type":"approximate","city":"Austin","region":"Texas","country":"US","timezone":"America/Chicago"},
 "allowed_callers":["code_execution_20260120"]}        // default on _20260209; ["direct"] disables dynamic filtering
```

- **Domain rules:** no scheme; subdomains are included automatically; paths are allowed (`example.com/blog`); `*` works only in the path. Use ASCII only (homograph risk). Invalid entries return a 400.
- **`user_location`:** `type` must be `approximate`, and at least one of city, region, country (ISO alpha-2) or timezone (IANA) is required.
- **Dynamic filtering:** Claude runs code that filters results before they reach its context. The API provisions code execution itself, so don't add a `code_execution` tool. If you do add one, it must be `_20260120` or later.
- **Code execution cost:** code execution is **free** in any request that includes `web_search_20260209` or `web_fetch_20260209` (or later).
- **Models:**
  - Opus 5.5 and Sonnet 5.5 support it ("Claude 4.6 and later models").
  - **Haiku 5.5:** the web search page says dynamic filtering works on "Claude 4.6 and later models", which includes Haiku 5.5. The programmatic-tool-calling list (the feature that needs `allowed_callers:["direct"]` when it's missing) names `claude-haiku-5-5`, and so does the code-execution list. No page names Haiku 5.5 on the web search tool by name, so keep the runtime check below. On models without programmatic tool calling, the API returns a 400 telling you to set `allowed_callers:["direct"]`, so fall back to that if Haiku errors.
  - Check at runtime with `client.models.retrieve(id)` → `capabilities.server_tools.web_search.supported`.
- **Price:** **$10 per 1,000 searches** plus tokens. Results count as input tokens on this turn and every later turn. A failed search isn't billed. Tally `usage.server_tool_use.web_search_requests` and add $0.01 each in `cost.ts`.
- **Response** (trimmed):
```json
{"content":[
 {"type":"server_tool_use","id":"srvtoolu_01W","name":"web_search","input":{"query":"LSC sponsor iRacing 2026"}},
 {"type":"web_search_tool_result","tool_use_id":"srvtoolu_01W","content":[
   {"type":"web_search_result","url":"https://…","title":"…","encrypted_content":"EqgfCio…","page_age":"April 30, 2025"}]},
 {"type":"text","text":"iRacing announced …","citations":[
   {"type":"web_search_result_location","url":"https://…","title":"…","encrypted_index":"Eo8BCio…","cited_text":"≤150 chars"}]}
],"usage":{"input_tokens":6039,"output_tokens":931,"server_tool_use":{"web_search_requests":1}},
 "stop_reason":"end_turn"}
```
- **Usage counters:** the docs' examples include only the counter for the tool that ran (`web_search_requests` or `web_fetch_requests`). Treat a missing counter as 0.
- **Citations** are always on for search. `cited_text`, `title` and `url` don't count toward tokens. If we show web-sourced text to users, the docs require citing the source.
- **Pass-back:** `encrypted_content` and `encrypted_index` must be sent back byte-for-byte. A missing or edited value returns a 400.
- **Nested blocks:** with dynamic filtering, nested `server_tool_use` and result blocks carry `"caller":{"type":"code_execution_20260120","tool_id":"srvtoolu_…"}`. The type is always `code_execution_20260120`, even when the request named `_20260521`. The response also includes code-execution result blocks and a top-level `container: {id, expires_at}`. In SDK 0.133.0, the code-execution result types are `code_execution_tool_result`, `bash_code_execution_tool_result` and `text_editor_code_execution_tool_result`. Which of these the dynamic-filtering path returns is **UNVERIFIED**, so treat unknown block types as opaque and pass them back verbatim.
- **Errors:**
  - HTTP 200 with `content: {"type":"web_search_tool_result_error","error_code":…}`, where the code is one of `too_many_requests`, `invalid_tool_input`, `max_uses_exceeded`, `query_too_long`, `request_too_large` or `unavailable`. Success means `content` is an **array**; error means it is an **object**. Branch on that.
  - An empty array means no results.

### 3c. Web fetch (`web_fetch_20260209`)

Versions: `_20250910` (basic), `_20260209` (dynamic filtering), `_20260309` (adds `use_cache:false`) and `_20260318` (adds `response_inclusion`). Model support and dynamic-filtering rules are the same as for search. **No extra charge**, tokens only (an average web page is about 2,500 tokens; a 500 kB PDF is about 125k).

```json
{"type":"web_fetch_20260209","name":"web_fetch","max_uses":5,
 "allowed_domains":["docs.google.com"],                   // domain-only match; a path entry never matches fetch
 "citations":{"enabled":true},                           // off by default
 "max_content_tokens":20000,                             // approximate; text only, not PDFs
 "url_sources":{"client_tool_results":{"type":"except","tools":[{"type":"tool_reference","name":"club_sql"}]}}}
```

- **Which URLs it can fetch:** only URLs that appeared earlier in **user messages**, **client tool results** or **earlier search/fetch results**.
  - **Not** from the system prompt, Claude's own output, or other server tools' results (tool search, code execution, MCP).
  - It refuses URLs that look like they contain a credential, unless that credential is in the system prompt or user text.
  - URLs are capped at 250 characters. No JS rendering. Only text, HTML and PDF content types work.
  - Results may be cached (`retrieved_at` shows when).
- **Response:** `web_fetch_tool_result` with `content.type:"web_fetch_result"`, plus `url` and `retrieved_at`, and `content.content` holding a `document` block (`source.type` is `text`/`text/plain`, or `base64`/`application/pdf`). Citations use the `char_location` or `page_location` shapes from 3d.
- **Error codes:** `invalid_tool_input`, `url_too_long`, `url_not_allowed`, `url_not_in_prior_context`, `url_not_accessible`, `too_many_requests`, `unsupported_content_type`, `max_uses_exceeded`, `unavailable`. These come back inside an HTTP 200 as `web_fetch_tool_result_error`. Failed fetches still count toward `max_uses`.

### 3d. User-uploaded files (PDFs and images)

Ways to attach a file:

| Source | Shape | Notes |
|---|---|---|
| base64 PDF | `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"<b64, no newlines>"}}` | Re-sent on every turn, so payloads grow. |
| URL PDF | `{"type":"document","source":{"type":"url","url":"https://…"}}` | The URL must be publicly fetchable by Anthropic, so it's no good for private Blob unless we use a signed URL (**UNVERIFIED** whether signed Blob URLs work). |
| Files API | `{"type":"document","source":{"type":"file","file_id":"file_011…"},"title":"…","citations":{"enabled":true}}` | Upload once and reference by ID. Best for multi-turn rooms. |
| image | `{"type":"image","source":{"type":"base64"/"url"/"file",…}}` | The block type must match the file's MIME type, or you get a 400. |

- **Limits:**
  - 32 MB per Messages request.
  - **600 PDF pages per request** (100 when the context window is under 1M; all three models are 1M).
  - No encrypted or password-protected PDFs.
  - Images: JPEG, PNG, GIF (first frame only) and WebP; at most 10 MB base64 each and at most 8000×8000 px; up to 600 images per request. **With more than 20 image blocks in one request, every image must be ≤2000 px** on each side, or you get a 400 (`invalid_request_error` mentioning "many-image requests"). The count includes images resent from earlier turns and images inside `tool_result`s. On the Claude API, documents don't count toward the 20; they do on Bedrock and Google-managed Vertex.
  - `.docx`/`.xlsx` aren't supported as documents: convert to PDF or text.
- **Cost:**
  - PDF: about 1,500 to 3,000 text tokens per page, **plus** each page is billed as an image.
  - Images cost `ceil(w/28) × ceil(h/28)` visual tokens. All three 5.5 models use the high-res tier, which downscales above a 2,576 px long edge or 4,784 tokens. Examples: 1000×1000 = 1,296 tokens; 1920×1080 = 2,691; 4K is capped at 4,784.
  - At Haiku 5.5's $0.10/MTok, a 4K screenshot is about $0.0005. Downscale before sending.
- **Citations on documents:** `citations.enabled` must be set on **all or none** of the documents. A PDF citation looks like `{"type":"page_location","cited_text":"…","document_index":0,"document_title":"…","start_page_number":1,"end_page_number":2}` (1-indexed, end exclusive). Citations with `output_config.format` (structured outputs) return a **400**.
- **Files API is GA (no beta header):** use `client.files.*`. SDK ≥0.122.0 is required for the stable shapes; we have 0.133.0.

| Call | Method + URL | Notes |
|---|---|---|
| Upload | `POST /v1/files` (multipart, field `file`, optional `expires_in_seconds` 3600 to 7,776,000) | TS: `client.files.upload({ file: await toFile(buf, name, { type }) })` |
| List | `GET /v1/files?limit=20&page=<next_page>` (limit at most 1000), or `?ids[]=…` (at most 100, single page) | Response `{data, next_page}`, newest first |
| Metadata | `GET /v1/files/{id}` | |
| Delete | `DELETE /v1/files/{id}` | Can't be recovered |
| Download | `GET /v1/files/{id}/content` | Only `downloadable:true` (code-exec/skill output). Uploads return a 400 here. |

Upload response:
```json
{"id":"file_011CNha8iCJcU1wXNR6q4V8w","type":"file","filename":"sponsor-deck.pdf","mime_type":"application/pdf",
 "size_bytes":1024000,"created_at":"2026-10-22T00:00:00Z","downloadable":false,"expires_at":"2026-11-21T00:00:00Z"}
```
Files API errors:
- `404 not_found_error` (`"File \`file_…\` not found."`), also returned after expiry for content downloads.
- `400` for wrong block type, not downloadable, larger than the context window, a bad filename (1 to 255 chars; no `<>:"|?*\/` or control characters), or the 1 TB org storage limit.
- `413` for files over 500 MB.
- A Messages request that references an expired file fails before inference.

## 4. Webhooks/events

None for what we use. Anthropic sends no webhooks for Messages, Files or Batches. Anthropic does have beta webhooks, but only for **Claude Managed Agents** resources: agents, sessions, environments, deployments, vaults and memory stores. They're signed using `webhook-id`, `webhook-timestamp` and `webhook-signature` headers and a `whsec_` secret, and the SDK verifies them with `client.beta.webhooks.unwrap()`. We don't use Managed Agents, so the only "events" for us are SSE stream events.

- **Event order:** `message_start` → `content_block_start` / `content_block_delta` / `content_block_stop` → one or more `message_delta` (carrying `stop_reason` and the cumulative `usage` including `server_tool_use`) → `message_stop`. `ping` events can appear anywhere.
- **Delta types:**
  - `text_delta`
  - `input_json_delta` (client and server tool inputs)
  - `thinking_delta`, then `signature_delta`. Thinking text is empty by default on the 5.5 models.
  - `citations_delta`: `{"type":"citations_delta","citation":{…one citation…}}`, appended to the current text block's `citations`.
- **Server tool results** (`web_search_tool_result`, `web_fetch_tool_result`, `tool_search_tool_result`) arrive whole in `content_block_start`, after a pause while the tool runs.
- **Mid-stream errors:** `event: error` / `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`. That's the same condition as an HTTP 529.
- **No signatures to verify** for Messages or Files.

## 5. Rate limits, quotas, plan limits, retention

- **Messages, Start tier, per model** (Opus 5.5, Sonnet 5.5 and Haiku 5.5 each have their own bucket): 1,000 RPM, 2M ITPM, 400k OTPM. Cache reads don't count toward ITPM.
  - Hitting the limit gives a 429 `rate_limit_error` with `retry-after`.
  - Headers: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`.
  - New orgs may sit in a lower "Evaluation" tier.
- **Spend:**
  - The Start tier cap is $500/month. At the cap you get a 429 with `error.details.error_code:"enforced_spend_limit_reached"` and **no `retry-after`**; SDK retries keep failing until the 1st of the month at 00:00 UTC.
  - **Our own limit** ($50 for live Jack) returns a **400 `invalid_request_error`**. An org limit's message starts "You have reached your specified API usage limits". A **workspace** limit, which is what a dedicated `jack` workspace gives us, starts "You have reached your specified workspace API usage limits". Match on the shared prefix "You have reached your specified". Jack must show a friendly error for all of these and not retry.
- **Web search:** there is an org-level web search rate limit. The docs don't publish the number; it shows only on the Console Rate limits page (`platform.claude.com/usage/limits`). The Batches API throttles searches further. Per-call problems surface as `too_many_requests` inside the 200 response.
- **Tool search:** may return `too_many_requests` or `execution_time_exceeded` inside the 200. No published numbers.
- **Files API:** about 500 requests per minute shared across all file operations; 500 MB per file; 1 TB per org. File operations are free.
- **Code execution** (only when no web tool is present): 1,550 free hours per org per month, then $0.05 per container-hour. A container is checkpointed after about 5 minutes idle and can be restored by ID until 30 days after creation. After that it can't be reused.
- **Pricing per MTok** (input / output / cache read):
  - Opus 5.5: $4 / $20 / $0.20
  - Sonnet 5.5: $2 / $10 / **$0.10** (0.05× input)
  - Haiku 5.5: $0.10 / $0.50 / $0.01 up to 100k prompt tokens, and $0.50 / $2.50 / $0.05 over 100k (the whole request is billed at the higher rate).
  - Tool-use system prompt overhead is 286 tokens on all three with `tool_choice` `auto`/`none`. Haiku 5.5 uses 406 with `any`/`tool`; Opus 5.5 and Sonnet 5.5 reject those.
  - `inference_geo:"us"` costs 1.1×.
- **Retention:**
  - Conversation content isn't retained by default except on Covered Models (Fable/Mythos, which we don't use). Nothing is used for training without permission. Flagged content may be kept up to 2 years.
  - **Files** stay until deleted or expired, and content may linger briefly for safety review.
  - **Code execution** (and so `_20260209` dynamic filtering) keeps container data up to 30 days.
  - ZDR-eligible: tool search, PDFs, citations, basic web search/fetch, and `_20260209` with `allowed_callers:["direct"]`.
  - Not ZDR-eligible: Files API, code execution, programmatic tool calling, and `_20260209` with dynamic filtering on. We don't have ZDR, so this is for information only.

## 6. Gotchas, policy, privacy

1. **Web fetch is an exfiltration channel.** Jack can read all app data, including PII. A URL in a client tool result (for example a DB row containing a link) becomes fetchable, and query strings carry data to third parties. Publishers may log URL parameters even under ZDR. Mitigate:
   - Exclude the SQL tool (or all client tools) from `url_sources.client_tool_results`.
   - Set `max_uses`.
   - Consider `allowed_domains` for scheduled jobs.
   - Never put secrets in user-visible text.
2. **Never accept `file_id`s from the browser.** Files are workspace-wide. Store our own `{fileId, uploaderId, roomId}` mapping and resolve IDs on the server only. Delete files when a room is deleted, or set `expires_in_seconds`.
3. **Vercel request body limit:** 4.5 MB for a function's request or response body. Anything larger gets `413 FUNCTION_PAYLOAD_TOO_LARGE`. Upload user files straight to private Blob from the client. Then the server streams Blob → `client.files.upload`, or base64 for small files, and sends only the `file_id` in Messages.
4. **300 s function cap:** the room page sets `maxDuration = 300`. That's the Hobby maximum and the Pro default; Pro can raise it to 800 s with Fluid compute. Web search turns can run long and return `pause_turn`. Stream every call (`client.messages.stream(...).finalMessage()`), cap continuations (e.g., 3), and persist partial turns so a later invocation (pg_cron/pg_net) can resume. When resuming, re-send the assistant content **unchanged** with the **same `tools`**.
5. **Mixed server and client tool calls in one turn:** if Claude calls `web_fetch` and `club_sql` in parallel, the response has `stop_reason:"tool_use"` and a `server_tool_use` with **no result yet**. Reply with a user message that contains **only** `tool_result` blocks; any extra text gives a 400. The fetch result then arrives as the first block of the next response.
6. **Keep `tools` and history append-only.** On all three 5.5 models, changing `system`, `tools` or earlier messages before a replayed thinking block gives a 400 for accounts created on or after 2026-08-31 00:00 UTC. On older accounts, the API still runs the check but lets a failing block through, unless the request sets `thinking.block_binding.prefix_mismatch_behavior` (a beta field). The club's org is older, but don't rely on that. Toggling web search or citations also invalidates the system and messages caches. So: declare the full toolset (deferred) every turn in a fixed order, and decide per request type (chat vs. scheduled digest) rather than mid-conversation.
7. **Forced `tool_choice`** (`any`/`tool`) returns a **400 on Opus 5.5 and Sonnet 5.5** (`tool_choice: type "tool" and "any" are not supported for this model.`), including on the token-counting endpoint. Haiku 5.5 accepts it but then skips thinking. Use `auto` plus a prompt instruction (and `strict: true` if the input shape matters).
8. **Errors don't throw for server tools.** Check `content` shape (array vs. object) and `stop_reason` (`end_turn`, `tool_use`, `pause_turn`, `max_tokens`, `refusal`). A refusal carries `stop_details.category`. Haiku 5.5 has no server-side refusal fallback. Opus 5.5 and Sonnet 5.5 have one only as an opt-in beta (`fallbacks: "default"`).
9. **`cost.ts` mismatch:** `cost.ts` prices the Sonnet 5.5 cache read at $0.20/MTok, but the pricing page says **$0.10**. It also doesn't add the $0.01 per web search. Fix both when wiring web search.
10. **Image privacy:** Claude refuses to name people in images. Officer photos are fine to describe but not to identify.
11. **Web fetch can't reach logged-in or JS-rendered pages** (Instagram, Discord, most dashboards). Use our connectors for those.

## 7. How to fake it locally

Point the real SDK at a local server (`ANTHROPIC_BASE_URL=http://127.0.0.1:4010`) so our code paths, SDK parsing and stream helpers stay real. The fake is **scripted** (fixture per test: input match → canned blocks), not a model. It must reproduce:

- **`POST /v1/messages`**, JSON and SSE (`stream:true`):
  - Exact event order and `content_block_start` payloads.
  - Server tool results as single `content_block_start` events.
  - `citations_delta`.
  - `message_delta.usage.server_tool_use.{web_search_requests,web_fetch_requests}` so the cost tally is tested.
- **Validation the real API does** (fail with the same HTTP status and error type):
  - 400 if every tool is deferred.
  - 400 if a `tool_reference` names a tool not in `tools[]`.
  - 400 if `cache_control` is on a deferred tool.
  - 400 if `allowed_domains` and `blocked_domains` are both set.
  - 400 if `tool_choice` is `any`/`tool` on opus/sonnet-5-5.
  - 400 if a `tool_result` targets a `srvtoolu_` ID.
  - 400 if text follows the `tool_result`s in a mixed-turn resume.
  - 400 if `encrypted_content` differs from what was issued (keep an HMAC of issued values).
  - 400 if a document block references an image file (or the reverse).
- **Tool search:** run real BM25/regex over the request's deferred tools (simple scoring is fine). Emit `server_tool_use` + `tool_search_tool_result`, then the scripted `tool_use`.
- **Web search/fetch:** fixture results with fake `encrypted_content`/`encrypted_index`, plus the error-object variants for every error code.
  - Enforce `url_not_in_prior_context`: scan user messages, client tool results (respecting `url_sources`) and prior search/fetch results.
  - Enforce `max_uses`.
  - Enforce the domain-filter semantics, including that a path entry never matches fetch.
- **Flow controls:**
  - `pause_turn`, and continuation when the paused content is re-sent.
  - The mixed-turn state: a dangling `server_tool_use`, then the result as the first block of the next response.
  - `stop_reason:"refusal"` with `stop_details`.
- **Failure injection:**
  - 429 with `retry-after`.
  - 429 `enforced_spend_limit_reached` without `retry-after`.
  - 400 "You have reached your specified API usage limits" and the workspace variant "You have reached your specified workspace API usage limits".
  - 401 `authentication_error` (expired or deleted key).
  - 529 / mid-stream `overloaded_error`.
- **Files:**
  - `POST /v1/files` (multipart) returns the object shape above, with `file_` IDs and `expires_at`.
  - `GET /v1/files` with `next_page` and `ids[]`.
  - `GET` and `DELETE /v1/files/{id}`.
  - 404 after delete or expiry.
  - `/content` returns 400 for uploads.
  - Enforce 500 MB, the filename rules and MIME → block-type matching.
  - Keep file bytes in memory so tests can assert what was "sent".
- **Pass-through rule:** any block type the fake doesn't model must round-trip untouched. Our client must never rewrite assistant content.

## 8. Sources

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
- https://platform.claude.com/docs/en/build-with-claude/pdf-support
- https://platform.claude.com/docs/en/build-with-claude/files
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://platform.claude.com/docs/en/build-with-claude/citations
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/api/rate-limits
- https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/models/haiku-5-5/overview, /whats-new-haiku-5-5, /migration-guide
- https://platform.claude.com/docs/en/models/opus-5-5/migration-guide, https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
- https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
- https://platform.claude.com/docs/en/manage-claude/authentication, https://platform.claude.com/docs/en/manage-claude/workspaces
- https://platform.claude.com/docs/en/api/overview, https://platform.claude.com/docs/en/api/versioning
- https://platform.claude.com/docs/en/managed-agents/webhooks (webhooks exist only for Managed Agents)
- https://vercel.com/docs/functions/limitations
- Installed typings: `apps/platform/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`, `client.js` and `resources/beta/webhooks.d.ts` (v0.133.0)

## Checked

Re-verified on 2026-10-22 against the pages above, the installed SDK (0.133.0) and `apps/platform/src/server/jack/cost.ts`.

**Confirmed as written:**
- **Tool search:** types and names, undated aliases, query limits (500 chars BM25, 200 chars regex), 10,000 deferred tools, default `limit` of 5 (range 1 to 10,000), model list, both 400 messages and the four `error_code`s, the `cache_control` 400, cache preservation, streaming, Batches support, not metered.
- **Web search:**
  - Versions and price ($10 per 1,000; failed searches not billed).
  - Domain-filter rules and the org-subset rule.
  - `user_location` fields.
  - The `allowed_callers` default.
  - Free code execution with `_20260209` or later.
  - `encrypted_content` pass-back (400 if missing or edited).
  - Error codes, and object-vs-array on error.
- **Web fetch:**
  - Versions (`use_cache` on `_20260309`, `response_inclusion` on `_20260318`).
  - Which URLs it can fetch, `url_sources`, and the credential-in-URL rule.
  - 250-char URLs; text/HTML/PDF only; no JS rendering.
  - Error codes; failed fetches count toward `max_uses`.
  - No extra charge, and the token estimates.
- **Files API:** GA with no beta header, all five endpoints and methods, multipart field `file`, `expires_in_seconds` 3,600 to 7,776,000, list `limit` up to 1,000, `ids[]` up to 100, response shape, 500 MB per file, 1 TB per org, about 500 file requests per minute, error codes, workspace scoping.
- **PDF and vision limits:**
  - 32 MB per request.
  - 600 pages (100 under 1M context); all three 5.5 models are 1M.
  - High-res image tier (2,576 px / 4,784 tokens) and the token examples.
  - Citations: all-or-none, `page_location` shape, 400 with `output_config.format`.
- **Rate limits and spend:**
  - Start tier: 1,000 RPM / 2M ITPM / 400k OTPM per model, with separate buckets.
  - Cache reads excluded from ITPM.
  - Spend-cap 429 with `enforced_spend_limit_reached` and no `retry-after`.
  - $500 Start cap; Default workspace can't have a spend limit.
- **Pricing:**
  - All three models' prices match the pricing page, including Sonnet 5.5's $0.10 cache read.
  - `cost.ts` still has 0.2 for Sonnet 5.5, so gotcha 9 is real.
  - 1.1× for `inference_geo:"us"`.
- **Retention and ZDR:** matches the ZDR eligibility table.
- **Model behavior:**
  - Forced `tool_choice` returns a 400 on Opus/Sonnet 5.5 (Haiku 5.5 accepts it).
  - Thinking text is empty by default on all three.
  - Prefix-check 400 on all three for new accounts.
  - Haiku 5.5 has no refusal fallback.
- **SDK:** `ANTHROPIC_BASE_URL` is read by SDK 0.133.0, and the listed TS types exist.

**Corrected:**
- Auth (§2): `Authorization: Bearer` is now the main header (`x-api-key` is legacy but works). A newer `anthropic-version: 2026-10-21` exists (opt-in). API keys **can** expire (set at creation; 401 after). Recommend a service account key, since personal keys die when the owner leaves the org.
- Spend limit (§5, §7): a workspace spend limit returns a different message ("…specified workspace API usage limits…"). Match on the shared prefix.
- Many-image rule (§3d): over 20 **image** blocks triggers the 2000 px limit. Documents don't count on the Claude API.
- Webhooks (§4): Anthropic does have beta webhooks (Standard-Webhooks-style signatures), but only for Managed Agents resources. Messages and Files still have none.
- Smaller fixes:
  - Usage example: dropped `web_fetch_requests:0`; treat a missing counter as 0.
  - One or more `message_delta` events.
  - Container lifetime wording.
  - 286-token overhead applies with `auto`/`none` only.
  - The 300 s cap is our `maxDuration` (Pro allows 800 s).
  - Refusal `stop_details.category`; the fallback is a beta on Opus/Sonnet 5.5.
  - The exact text of the forced `tool_choice` error.

**UNVERIFIED items resolved:**
- Vercel 4.5 MB body limit: confirmed.
- Web search org rate limit: confirmed it's shown only in the Console, not published in the docs.
- Haiku 5.5 dynamic filtering: supported per "Claude 4.6 and later" plus the programmatic-tool-calling list. No page names it on the web search tool by name, so keep the runtime `capabilities.server_tools.web_search.supported` check.

**Still unverified:**
- Whether signed private Vercel Blob URLs work as a `url` document source.
- Which code-execution result block types appear in the dynamic-filtering path. The candidates are listed in §3b.
- That the club's org was created before 2026-08-31.
- Which Vercel plan the project is on (it decides whether 800 s is available).
