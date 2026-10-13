# Jack

Jack is the officer chat agent in the admin console (**Admin → Jack**, #161). Officers ask about club data (members, events and attendance, LSC entries, payments, standings, the audit log) and get plain answers, query results and charts back. Jack can also draft an event for an officer to review. He only reads, except for those drafts, and he never moves money.

Code paths below are relative to `apps/platform/`.

## Rooms

- A room is a shared chat. Every officer sees every room and can post in it; there are no private rooms.
- Each message stores its author: an officer, a model (Jack, Lift or Stand), or the room itself (notes like "Gray switched this room to Lift").
- Jack answers on the server, so closing the tab doesn't stop an answer. One answer runs per room at a time (a run lock on the room); messages posted while he's answering wait, and the next answer covers all of them together.
- Text streams to everyone in the room over a private Supabase Realtime channel. Someone who opens a room mid-answer sees what's been written so far and then follows along. Tool calls show up in the reply where they happened: a part per call, "running" while it works, then its result (a query and its rows, a chart, an event draft) or an error.
- Only officers can join the channels; a database policy enforces it.

## Personas

| Name | Model | Effort | Used for |
|---|---|---|---|
| Jack | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | medium | Every answer, by default |
| Lift | Claude Opus 5.5 (`claude-opus-5-5`) | high | Harder questions. Set per room with **Answered by**; it stays until someone switches back, and the switch is posted in the room. About twice Jack's price per token |
| Stand | Claude Haiku 5.5 (`claude-haiku-5-5`) | low | Side jobs: naming a new room after its first answer |

The names are the joke; the answers stay plain. Models and effort live in `src/server/jack/models.ts`. These models always think before answering (adaptive thinking can't be turned off); effort is the dial for how much.

## How a reply works

1. An officer posts. The message is saved, shown to the room, and `runRoom()` starts after the response (`src/server/jack/reply-loop.ts`).
2. If `ANTHROPIC_API_KEY` isn't set, the reply says so ("Jack isn't connected yet…"). If this month's spend has reached `JACK_MONTHLY_BUDGET_USD`, the reply says the budget is used up. Neither calls Claude.
3. Otherwise the request is built (`src/server/jack/model-loop.ts`), in this order:
   - **tools**, in the fixed order of `JACK_TOOLS` (`src/server/jack/tools/index.ts`);
   - the **system prompt** (`src/server/jack/prompt.ts`): who Jack is, who he's talking to, the club, and the rules (read-only except drafts, never move money, say where numbers came from, Central Time, emails and EIDs only when asked, concise plain text, typed tools first, `run_sql` for the rest, `describe_schema` when unsure, charts through the chart tool), then the notes on the club's tables (`JACK_SCHEMA_NOTES` in `src/server/jack/tools/schema-notes.ts`);
   - the **room history** (`src/server/jack/history.ts`): each exchange as an officer turn ("Name: message" lines under a Central Time timestamp, room notes included) and the reply's text with a one-line note of the tools it used. Several officers' messages answered together are one turn, and notices that never reached Claude ("isn't connected yet") are left out so their questions carry over. The last 40 exchanges are sent.
4. Claude streams. Text goes out in ~150 ms batches. Each tool call is checked against the tool's schema, run as the officer whose message is newest, saved on the reply (`JackMessage.toolCalls`) and broadcast (`message.tool`), and its result goes back to Claude. This repeats until Claude answers.
5. Limits per reply: 12 tool calls, then Claude is told to answer with what it has (and can't call more tools); the same after 150 s or 64K output tokens; 16K output tokens per call for Jack, 32K for Lift.
6. The finished reply is saved with its model, tokens and cost, and its cost is logged (`[jack] Reply … $0.0123, … in + … cache write + … cache read, … out`).
7. If the room has no title yet, Stand names it in 2 to 5 words in the background and posts "Stand named this room “…”".

What the room sees when something goes wrong:

| What happened | The reply |
|---|---|
| Claude's safety checks declined | "I can't help with that one…" (status done). A partial answer before the decline is dropped |
| An answer cut off at the length limit | The text so far plus a note. A tool call that was cut off isn't run |
| The API failed (rate limit, overload, bad key, network) | The text so far plus a plain explanation, status **error** |
| A tool failed | The part shows the error; Claude sees it and usually works around it |

### Refusals

Sonnet 5.5 and Opus 5.5 run safety classifiers that can decline a request (cyber, bio and a few other categories), occasionally on harmless club questions. Replies opt into Anthropic's server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a declined request is retried on the model Anthropic recommends for that category, inside the same call. The fallback attempt is billed at that model's rates, and the cost math prices each attempt by the model that ran it. Not every category is retried (from Sonnet 5.5, only cyber and frontier_llm declines are); then, or when the fallback model declines too, the room sees the refusal message. Haiku has no server-side fallback, so Stand just leaves the room untitled.

### Prompt caching

Every request starts with the same tools and system prompt, with a cache breakpoint at the end of the system prompt, and automatic caching on the conversation after it. Cache reads cost a tenth of normal input (less on Opus), so a room's follow-ups mostly pay for what's new. This stays cacheable because:

- the system prompt has no dates, names or counts in it (the time is in each officer turn instead), and the tools never change order;
- the history is rebuilt from the saved messages the same way every time, so each request's history is the previous one plus the new exchange. The 40-exchange window moves its start in steps of 10, so it stays put for several turns;
- within one reply, each Claude turn goes back exactly as it came (thinking included), with its tool results appended after it.

Thinking blocks are only ever sent back within the reply that made them. Earlier replies go back as text, so no thinking block is replayed into an edited conversation (which these models reject). Requests set `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`), so if a bug ever did edit the history, the reply would continue without that thinking instead of failing; it's logged as a warning.

## Costs

Prices per million tokens (cache writes are 1.25× input):

| Model | Input | Output | Cache read |
|---|---|---|---|
| Sonnet 5.5 (Jack) | $2 | $10 | $0.20 |
| Opus 5.5 (Lift) | $4 | $20 | $0.20 |
| Haiku 5.5 (Stand) | $0.10 | $0.50 | $0.01 |

Each reply's cost is the sum over its Claude calls (one per tool round) of uncached input, cache writes, cache reads and output at those rates (`src/server/jack/cost.ts`). It's saved on the reply: `model`, `inputTokens` (everything not read from the cache), `cacheReadTokens`, `outputTokens` and `costUsd`. Stand's cost is saved on its "named this room" note.

The **spend meter** on the rooms page and in each room's header shows this calendar month (Central Time): "October: $3.20 of $200 · Lift $0.90", with Jack, Lift and Stand split out on hover (`src/server/jack/spend.ts`). It's as of page load.

When the month's total reaches `JACK_MONTHLY_BUDGET_USD` (default $200), Jack stops calling Claude and says the budget is used up until the 1st, Central Time. Set a spend limit in the Anthropic Console as well, a little above it, as the hard backstop.

## Environment variables

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | The Claude API key. Without it Jack answers "isn't connected yet". Server only; never `NEXT_PUBLIC_`. |
| `JACK_DATABASE_URL` | The connection string for `jack_readonly`, the read-only Postgres role Jack's SQL and typed tools run as (SELECT on public tables except `SystemSetting`, read-only transactions, a short timeout). Locally `scripts/jack-local-sql-role.ts` sets the role up and prints it. |
| `JACK_MONTHLY_BUDGET_USD` | Optional. Spend cap per calendar month, in dollars. Default 200. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Jack broadcasts replies to the private room channels with it. Locally, `SERVICE_ROLE_KEY` from `npx supabase status -o env`. |

## Production setup

1. **Anthropic Console.** Create an API key for the club's workspace, and set the workspace's monthly spend limit a little above `JACK_MONTHLY_BUDGET_USD`.
2. **The read-only role.** The migration creates `jack_readonly` without a login. In the Supabase SQL editor, give it one with a long random password (never in git):
   `ALTER ROLE jack_readonly LOGIN PASSWORD '…';`
   Then build `JACK_DATABASE_URL` from the transaction pooler string with the username `jack_readonly.<project-ref>` and `?pgbouncer=true`.
3. **Vercel** (Production): add `ANTHROPIC_API_KEY`, `JACK_DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and `JACK_MONTHLY_BUDGET_USD` if the cap isn't $200. Add them to Preview only if previews should answer too (they share whatever database they point at). Redeploy.
4. **Check it.** Open a room, ask "How many members are there?", and watch the answer stream with a query part. The function log shows a `[jack] Reply …` line with the cost; the room gets a name from Stand.

### Function duration

Posting runs the whole reply loop after the response, inside the room page's function (Server Actions use their page's settings), so `maxDuration` on `src/app/admin/jack/[roomId]/page.tsx` is **300 s**. A typical answer takes 5 to 60 seconds; one with many tool calls is told to wrap up after 150 s, and one still going at 240 s is cancelled (its Claude call and any running tool are aborted, and the reply says it was stopped), which leaves room for messages that arrived meanwhile. 300 s is Vercel's Fluid compute default and the most the Hobby plan allows (Pro allows up to 800 s). Keep it under the room lock's 10-minute stale time (`src/server/jack/room-lock.ts`): if a function is cut off, the next post into that room closes the half-written reply as an error after the lock goes stale.

## The eval

`scripts/jack-eval.ts` is the test set from #161: 16 questions officers ask (LSC applications and paid entries, rounds missing results, unpaid checkouts, charges this month, accounts, officers, upcoming events, GM 1, check-ins, a chart, drafting an event). The right answers are worked out from the database when it runs, and each question goes through the same code a room reply does, on Jack and on Lift. It prints pass or fail per question, then accuracy, cost and latency per model.

```bash
# from apps/platform, with DATABASE_URL, JACK_DATABASE_URL and ANTHROPIC_API_KEY in .env.local
pnpm exec tsx scripts/jack-eval.ts              # both models, a few dollars
pnpm exec tsx scripts/jack-eval.ts --only=jack  # one model
pnpm exec tsx scripts/jack-eval.ts --filter=lsc # some questions
pnpm exec tsx scripts/jack-eval.ts --verbose    # print every answer
pnpm exec tsx scripts/jack-eval.ts --dry-run    # no API calls: a fake model checks the plumbing
```

- It refuses to run without `ANTHROPIC_API_KEY`, except with `--dry-run`.
- It asks as the first admin, or `--as=<email|handle>`; the draft is credited to them. The draft question checks the event was created as a DRAFT on the right day and time, then deletes it (its audit log entry stays). Nothing else is written.
- Questions with nothing to ask about (no open LSC season, no check-ins yet) are skipped.
- Checks look for the right numbers, names and Central Time dates in the answer, and for a chart whose bars add up. A failure prints what was expected next to the answer.

Run it against a copy of real data before the pilot to pick the default persona, and again after changing the prompt, the tools or a model.

## Tests

`pnpm test` covers Jack without a network or database: the model loop against a scripted fake Claude stream (`src/server/jack/fake-claude.ts`), tool calls and parts, the tool-call cap, refusals and API errors, the missing-key and budget messages, cost math, history building, Stand, and the room reducer that merges live events with snapshots.
