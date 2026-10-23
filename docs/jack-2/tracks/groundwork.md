Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Model loop 2.0 (G8)

Design §7.1, §7.2 and §7.4. Code paths are relative to `apps/platform/`.

### Web search and fetch
- **On/off:** `JACK_WEB_TOOLS=on` adds Anthropic's server tools `web_search_20260209` and `web_fetch_20260209` to **room replies** (`src/server/jack/web-tools.ts`). Unset, the request is exactly what it was before.
- **Request types:** `runModelReply` takes `requestType: "room" | "scheduled"` (default `"room"`), and so does `runRoom(roomId, deps, { requestType })`. Scheduled runs (recurring questions, digest summaries) **never** get the web tools, whatever the flag says. Tools see it as `ctx.requestType`.
- **Tool order** (it starts the cached prefix): Jack's tools in registry order, then the tool search tool when any tool is deferred, then web search and fetch. It changes only with the flag and the request type, never mid-conversation.
- **Limits:**
  - per API call: 5 searches, 3 fetches, about 10K tokens of a page's text (`WEB_LIMITS`);
  - per reply: 8 searches and 5 pages (`REPLY_LIMITS.maxWebSearches` / `maxWebFetches`), counted from each call's `usage.server_tool_use`. Past either, the reply is told to wrap up (`tool_choice: none` stops server tools too).
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
- **pause_turn:** the paused turn goes back unchanged and the reply carries on. If the reply has used its web share by then: with nothing pending it gets the wrap-up note; with a call pending it stops with "used up its web searches".
- **Refusal fallback:** the declined model's thinking and tool calls before the switch don't go back, and now neither do its server tool calls' **results** (a result without its call is a 400), and its text goes back without citations.
- **Spend limits:** `isSpendLimitError` recognizes the Console's org limit ("You have reached your specified API usage limits"), a workspace's ("…specified workspace API usage limits") and the tier cap (429 `enforced_spend_limit_reached`). The room says the account hit its spend limit, instead of "a bug in Jack" or "too many requests".

### Tool search
- A tool with `deferred: true` is sent with `defer_loading: true` (keeping `eager_input_streaming`), and the request gets `tool_search_tool_bm25_20251119` after Jack's tools. A request with no deferred tool is unchanged.
- **To defer a tool:** set `deferred: true`, name it with its service's prefix (`stripe_overview`, `discord_polls`) and say what it covers in its description, since BM25 matches the name, description and argument names.
- Discovered tools come back as `tool_reference` blocks inside the turn, which goes back unchanged, so the cache survives. Across replies the history is text, so a later reply searches again.
- Only `web_links` is deferred so far, and it's only offered with the web tools, so with the flag off nothing is deferred and there's no search tool.

### `web_links` (`src/server/jack/tools/web-links.ts`, groundwork slot)
- Returns the links earlier replies in the room found: each reply's cited and opened pages, numbered in the order the room shows them, newest reply first (`replies`, default 3; `match` filters but keeps the numbers).
- It reads only parts named `web_search`/`web_fetch` (`toolCalls @> [{name}]`), so it can't hand web_fetch a link from club data. That's why web_fetch may follow its results.
- Deferred, and `web: true` (offered only with the web tools).
- A prompt line in `prompt-sections/groundwork.ts` says to use it: earlier replies' links aren't in the conversation, so web_fetch can't open them otherwise.

### History
The tool note on an earlier reply now records its web calls with the cited sites, e.g. `web_search {"query":"college sim racing sponsors"} → Searched the web (8 results, 2 cited) (cited: iracing.com, fia.com)`. Links aren't in it (web_links has them).

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
- **Fake Claude** (`src/server/jack/fake-claude.ts`): `FakeTurn.blocks` puts scripted blocks in a response, built with `fakeWebSearch`, `fakeWebFetch`, `fakeCitedText`, `fakeToolSearch` (and `searchDeferredTools`, a stand-in for BM25). It fills `usage.server_tool_use` from them, streams them the way the API does (server results whole, `citations_delta`), and `turn.container` sets the response's container. Every request goes through `requestProblem`, which fails it with a 400 where the real API would: every tool deferred, `cache_control` on a deferred tool, a `url_sources` tool that isn't in `tools`, forced `tool_choice` on Sonnet/Opus 5.5, a `tool_result` for a server call, text with the tool results while a server call is running, a server result without its call, a changed `encrypted_content`, an unknown `tool_reference`.

### Not verified live (no paid calls in this PR)
- `defer_loading` together with `eager_input_streaming`: both are fields of the SDK's `BetaTool` (0.133) and nothing in the tool search docs rules the pair out, but no request has been sent with both.
- Dynamic filtering on Haiku 5.5 (Stand): the research says it's supported. If Stand's replies fail with a 400 asking for `allowed_callers: ["direct"]`, add that to the web tools for Stand in `webServerTools`.
- Whether the `container` id must be sent on later calls for dynamic filtering; it's sent when a response had one.
- Searches in a call that fails before its final `message_delta` aren't counted: the API reports `server_tool_use` only there.
