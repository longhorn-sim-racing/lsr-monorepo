Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Model loop 2.0 (G8)

Design §7.1, §7.2 and §7.4. Code paths are relative to `apps/platform/`.

### Web search and fetch
- **On/off:** `JACK_WEB_TOOLS=on` adds Anthropic's server tools `web_search_20260209` and `web_fetch_20260209` to **room replies** (`src/server/jack/web-tools.ts`). Unset, the request is exactly what it was before.
- **Request types, per reply:** `runModelReply` takes `requestType: "room" | "scheduled"`, **required** (no default), so no caller gets the web tools by leaving it out (`jack-eval.ts` passes `"room"`). A scheduled reply **never** gets the web tools, whatever the flag says. Tools see it as `ctx.requestType`.
  - `runRoom` works it out for each reply from the messages it answers, not from the run: a reply to a note with `JackMessage.scheduled = true` is `"scheduled"`, every other reply is `"room"`.
  - A scheduled note is always answered in a **reply of its own**, never together with officer messages (`nextReplyBatch`). So whichever run picks it up (one an officer's post started, if that run holds the lock) answers it without web tools, and an officer message posted meanwhile still gets them. In the history, the note is in its own reply's turn only.
  - A scheduled reply leaves no deck continue note (that note's reply would be a room reply).
  - **For T11 (recurring questions):** post the note as `kind: "system", scheduled: true, authorUserId: <creator>` (answered as that officer), then call `runRoom(roomId, deps, { startedAt })` as usual. `scheduled` is a new column (migration `20261023060000_jack2_scheduled_notes`, additive). The room page doesn't show a waiting scheduled note as unanswered yet (`messages.ts` / `room-state.ts` only look at officer messages and continue notes); T11 decides whether it should.
- **Tool order** (it starts the cached prefix): Jack's tools in registry order, then the tool search tool when any tool is deferred, then web search and fetch. It changes only with the flag and the request type, never mid-conversation.
- **Limits:**
  - per API call: 5 searches, 3 fetches, about 10K tokens of a page's text (`WEB_LIMITS`);
  - per reply: told to wrap up once it has made 8 searches or opened 5 pages (`REPLY_LIMITS.maxWebSearches` / `maxWebFetches`), counted from each call's `usage.server_tool_use` (`tool_choice: none` stops server tools too). **This cap is soft**: it's checked when a call ends, and the call that crosses it can use its whole per-call share, so a reply can reach **12 searches and 7 pages** (7 + 5, 4 + 3). When the cap is crossed in a turn that's still waiting on a web call, the wrap-up note waits for the next call that ends with none pending, and each call before it can add its share (usually one more: 17 and 10).
  - Search results get `user_location` Austin, Texas (no member data).
- **What web_fetch may open** (`url_sources`): officers' messages (`user_input: all`), earlier search and fetch results (`server_tool_results: all`), and **no client tool's results except `web_links`'** (`client_tool_results: only [web_links]`, or `none` when web_links isn't offered). A link inside club data, a document, a Discord message or a `run_sql` row can never be fetched.
- **Fetched pages have no citations.** A request's documents must all have citations or none, and documents in tool results (below) don't.
- **Dynamic filtering** stays on (the `_20260209` default): Claude may run code to filter results. Its code-execution blocks are passed back verbatim, and the response's `container` id is sent on the reply's later calls.

### How the loop handles server tools (`src/server/jack/model-loop.ts`)
- **Parts:** each web search or fetch (`server_tool_use`, direct or nested under code execution) becomes a part with the call's id, named `web_search` or `web_fetch`, with a `web_sources` display:
  - a search shows its query and **the results the reply cites** (from the text blocks' `web_search_result_location` citations; a page cited from two searches shows under the first). Label: "Searched the web (8 results, 2 cited)".
  - a fetch shows the page it read ("Read fia.com"), or "Couldn't open example.com" with the reason.
  - It's "running" from the call's start, shows the query once its input has streamed, is done when the result arrives (whole, in `content_block_start`), and fills in its cited pages as citations arrive, including in later calls of the reply.
  - Tool search makes no part (it's plumbing).
- **Cited text:** each cited stretch is its own text block. Consecutive text blocks are now joined as written; a paragraph break goes in only after a non-text block (a tool call, a result, thinking).
- **Sent back unchanged:** every block in a turn goes back as it came, including block types the code doesn't know (`echoContent`).
- **Mixed turns:** when a turn calls Jack's tools while a web call is still running, its result comes first in the next response. Until then the user turn holds tool results only, so the wrap-up note waits a round (the limits only grow, so it still applies). The pending part stays "running" across the calls.
- **pause_turn:** the paused turn goes back unchanged and the reply carries on. It's checked against the same limits as a tool round (tool calls, web searches, pages, output tokens and time). If one is reached: with nothing pending it gets the wrap-up note; with a call pending it stops and says which limit it hit ("used up its web searches", "opened all the web pages it can", "ran long").
- **Refusal fallback:** the declined model's thinking and tool calls before the switch don't go back, and now neither do its server tool calls' **results** (a result without its call is a 400), and its text goes back without citations.
- **Spend limits:** `isSpendLimitError` recognizes the Console's org limit ("You have reached your specified API usage limits"), a workspace's ("…specified workspace API usage limits") and the tier cap (429 `enforced_spend_limit_reached`). The room says the account hit its spend limit, instead of "a bug in Jack" or "too many requests".

### Tool search
- A tool with `deferred: true` is sent with `defer_loading: true` (keeping `eager_input_streaming`), and the request gets `tool_search_tool_bm25_20251119` after Jack's tools. A request with no deferred tool is unchanged.
- **To defer a tool:** set `deferred: true`, name it with its service's prefix (`stripe_overview`, `discord_polls`) and say what it covers in its description, since BM25 matches the name, description and argument names.
- Discovered tools come back as `tool_reference` blocks inside the turn, which goes back unchanged, so the cache survives. Across replies the history is text, so a later reply searches again.
- Only `web_links` is deferred so far, and it's only offered with the web tools, so with the flag off nothing is deferred and there's no search tool.

### `web_links` (`src/server/jack/tools/web-links.ts`, groundwork slot)
- Returns the links earlier replies in the room found: each reply's cited and opened pages, numbered in the order the room shows them, newest reply first (`replies`, default 3; `match` filters but keeps the numbers).
- web_fetch may follow anything in its result, so **its result holds only what came back from the web**: each link's `n`, `title` and `url` from the `web_sources` displays of parts named `web_search`/`web_fetch` (`toolCalls @> [{name}]`), plus each reply's time. Never text the model wrote: not the earlier searches' queries, not a fetch's input, and not `match` (a miss says "No links match that text"). Otherwise a prompt-injected model could write a link with data in it (into `match`, or into a search query) and then fetch it. Tests check both, end to end against the fake.
- Deferred, and `web: true` (offered only with the web tools).
- Two prompt lines in `prompt-sections/groundwork.ts`: web_fetch can't open a link from an earlier reply (even one in its text), so get it with web_links first; and web_links is the one tool whose links Jack may fetch (the exception to G1's "never fetch a link from another tool's result").

### History
The tool note on an earlier reply now records its web calls: a search with its query and the cited sites, a fetch with only its label, e.g. `web_search {"query":"college sim racing sponsors"} → Searched the web (8 results, 2 cited) (cited: iracing.com, fia.com); web_fetch → Read fia.com`. No links are in it (web_fetch couldn't open them from an earlier reply anyway; web_links has them).

Notes a reply answers (a deck's continue note, a scheduled question) are placed in that reply's turn by `answeredById`, like officer messages; other room notes still go by time.

### Documents in tool results
`JackToolResult.documents` (`JackModelDocument`): a PDF by Claude Files API id (`{ type: "file", fileId }`, uploaded on the server, never an id from the browser) or base64. They go in the `tool_result` after the text and before any images, each after its caption, at most 5 per result. The id must be a PDF's: an image's file id in a `document` block is a 400. Images are still base64 only (`JackModelImage`).

### Cost
`cost.ts` adds $0.01 per web search (`WEB_SEARCH_USD`, from `usage.server_tool_use.web_search_requests`; a missing counter is 0; failed searches aren't counted by the API). Fetches cost tokens only. `UsageTally` also counts `webSearches` and `webFetches`; the reply's log line shows them when there were any.

### Env and setup
| Variable | Notes |
|---|---|
| `JACK_WEB_TOOLS` | `on` gives room replies web search and fetch. Off when unset. Already in `.env.example`. |

**Before turning it on** (Gray, design §15): Anthropic Console → Settings → Capabilities → allow **web search** and **web fetch**. If either is off, every request that includes it fails with a 400, so every reply fails. Then set `JACK_WEB_TOOLS=on` in Vercel and redeploy.

**Smoke test** (one paid question): in a room ask "Search the web for the FIA's esports program and give me the link." Expect a "Searched the web (… cited)" part with hosts, and a `[jack] Reply … N web searches` log line with the cost about $0.01 a search higher. Then "open the first link": expect a web_links call and "Read <host>".

### Trying it locally (no Claude API, nothing paid)
- `pnpm --filter @lsr/platform exec tsx scripts/try-jack-web.ts` runs the real reply loop with `JACK_WEB_TOOLS=on` in a new local room, against the scripted fake Claude: a search with citations, then "Open the second link" (tool search → web_links → web fetch). It prints the parts, tool notes, costs and the request's server tools, then deletes the room. With `--keep` it keeps the room and prints its link, to look at the parts in the browser.
- Tests: `model-loop-web.test.ts` (every case above), `web-tools.test.ts`, `tools/web-links.test.ts`, `fake-claude.test.ts`, plus additions to `cost.test.ts`, `history.test.ts` and `reply-loop.test.ts`.
- **Fake Claude** (`src/server/jack/fake-claude.ts`): `FakeTurn.blocks` puts scripted blocks in a response, built with `fakeWebSearch`, `fakeWebFetch`, `fakeCitedText`, `fakeToolSearch` (and `searchDeferredTools`, a stand-in for BM25). It fills `usage.server_tool_use` from them, streams them the way the API does (server results whole, `citations_delta`), and `turn.container` sets the response's container. `fakeFileId("pdf" | "image")` makes a stand-in Files API id for document and image blocks. Every request goes through `requestProblem`, which fails it with a 400 where the real API would: every tool deferred, `cache_control` on a deferred tool, a `url_sources` tool that isn't in `tools`, forced `tool_choice` on Sonnet/Opus 5.5, a `tool_result` for a server call, text with the tool results while a server call is running, a server result without its call, a changed `encrypted_content`, an unknown `tool_reference`, a file id in the wrong block type, and citations on some documents but not others.
  - **Server tool rules** (`enforceServerTools`): a scripted web call gets the result the API would give instead of its scripted one. A fetch of a link that isn't in the prior context gets `url_not_in_prior_context` (`fetchableUrl`: officers' turns, client tool results as `url_sources` allows (`all`/`none`/`only`/`except`, default `all`), and earlier search and fetch results, never the model's own text or a tool search result; a substring match). A call past its tool's `max_uses` in one response gets `max_uses_exceeded`. So a test that fetches a link has to put it in context first (an officer's message, a search, or web_links).

### Not verified live (no paid calls in this PR)
Check these with the smoke test above, before relying on the web tools:
- `defer_loading` together with `eager_input_streaming`: both are fields of the SDK's `BetaTool` (0.133) and nothing in the tool search docs rules the pair out, but no request has been sent with both.
- **`url_sources` naming a deferred tool:** `client_tool_results: only [web_links]` names `web_links`, which is sent with `defer_loading`. If the API requires a tool named in `url_sources` to be loaded, every reply with the web tools gets a 400 (the first smoke-test question shows it). Fallback: stop deferring web_links (drop `deferred: true`), or send `client_tool_results: none` and leave web_links out of the request.
- How the API matches a link against the prior context (exact, or normalized): the fake uses a substring match.
- Dynamic filtering on Haiku 5.5 (Stand): the research says it's supported. If Stand's replies fail with a 400 asking for `allowed_callers: ["direct"]`, add that to the web tools for Stand in `webServerTools`.
- Whether the `container` id must be sent on later calls for dynamic filtering; it's sent when a response had one.
- Searches in a call that fails before its final `message_delta` aren't counted: the API reports `server_tool_use` only there.
