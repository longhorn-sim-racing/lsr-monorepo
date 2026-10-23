Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Proposals (G4)

Jack proposes; an officer applies (design §4). Code paths are relative to `apps/platform/`.

### How it works

1. **Propose.** Jack calls a `propose_*` tool with `{ proposal: { kind, ...fields } }`. `createProposal` (`src/server/jack/proposals/service.ts`) validates the fields with the kind's schema, has the kind describe the change (`prepare`: title, summary, diff rows, people, links, rows; no writes), and saves a PENDING `JackProposal` that expires in 14 days. A newer proposal for the same kind and target in the same room marks the older pending ones SUPERSEDED (with a note). The reply shows a small `proposal` display: the title, summary and first few changed fields.
2. **Card.** `src/components/jack/parts/proposal-card.tsx` loads the whole proposal from `GET /api/admin/jack/proposals/[id]` (officers only): the saved view, with long text as a line diff (`src/lib/jack/line-diff.ts`, no library), names, and whether the viewer may apply it. It follows the live status from the room (the snapshot's `proposals` map and `proposal.updated` events); the reply's saved tool calls never change. Pending: **Apply** (asks first for kinds marked `destructive`) and **Discard**; list kinds get a checkbox per row (matched rows start checked). After: who applied or discarded it and what came of it. Outside links show their host (`PartLink`).
3. **Apply** (`applyJackProposal`, any officer; `applyProposal` in the service):
   - the kind's `permission` is checked against the **applying** officer's roles, read from the database;
   - the claim is one conditional update: `status PENDING → APPLYING, claimedAt = now WHERE id AND status = 'PENDING' AND expiresAt > now`, so of several officers clicking at once exactly one gets it;
   - then, outside any transaction: re-validate the payload, check the file's sha256 (kinds built from a file), `checkStale`, `apply`;
   - it ends **APPLIED** (result: summary, links, created ids, applied rows), **STALE** (the reason) or **FAILED** (the error, through `redactSecrets`). APPLIED and FAILED get an audit entry (`entityType: JACK_PROPOSAL`, `actionType: APPLY | APPLY_FAILED`, the applying officer as actor, `metadata { via: "jack", proposalId, roomId, proposedFor, kind }`).
4. **Discard** (`discardJackProposal`, any officer, any kind): DISCARDED, audited (`DISCARD`).
5. **Expiry is lazy:** a PENDING proposal past `expiresAt` reads as STALE everywhere (snapshot, route, Proposals page) and is written STALE, with a note, when it's opened or acted on. The sweep job writes it down too.
6. **Room notes for every final status**, as system messages, so Jack's history carries outcomes ("(Room note: Dylan applied: Edit the page “LSC Rules” → /admin/pages/…)"):
   - `Dylan applied: <title> → <first site link of the result>`
   - `Couldn't apply: <title>. <error>`
   - `Stale: <title>. <reason>` (also for expired: "Nobody applied it within 14 days.")
   - `Discarded by Gray: <title>`
   - `Superseded: <title>. Jack proposed a newer version.`
   The room links a note's trailing site path (`noteWithLink` / `noteLink` in `src/lib/jack/proposals.ts`, `NoteText` in the room).

### The pieces

| Piece | Where |
|---|---|
| Service: create, apply, discard, detail, room states, sweep | `src/server/jack/proposals/service.ts` |
| Errors kinds throw (`ProposalInputError`, `StaleProposalError`) | `src/server/jack/proposals/errors.ts` |
| Exact find-and-replace (all or none), for text kinds | `src/server/jack/proposals/text-edits.ts` |
| `page.update`, the reference kind | `src/server/jack/proposals/page-update.ts`, registered in `kinds/groundwork.ts` |
| Page service (the admin form and `page.update` both save through it) | `src/server/services/page.service.ts` |
| The `propose_*` tools | `src/server/jack/tools/propose.ts`, sent from `tools/registry/groundwork.ts` |
| Officer route | `src/app/api/admin/jack/proposals/[id]/route.ts` |
| Apply and Discard actions | `src/app/admin/jack/proposals/actions.ts` |
| Proposals page (Jack → Proposals) | `src/app/admin/jack/proposals/page.tsx`, list query in `src/server/jack/proposals/list.ts` |
| Card, its room context, note links | `src/components/jack/parts/proposal-card.tsx`, `proposal-context.tsx`, `src/components/jack/note-text.tsx` |
| Sweep job `proposals.sweep` | `src/server/scheduler/jobs/proposals.ts` (joined into the groundwork slot) |

### Adding a kind (for the other tracks)

1. Write the kind (`ProposalKind<P>`, `src/server/jack/proposals/types.ts`) in your track's code and add it to `src/server/jack/proposals/kinds/<track>.ts`. Set `tool` to one of the `propose_*` tools: **that tool appears as soon as one kind names it**, with your kind's `description` in its list. A tool with no kinds isn't sent. The rarer tools (`propose_discord`, `propose_deck_publish`, `propose_meeting`, `propose_recurring`) are marked `deferred` for tool search (G8).
2. **`schema` must be a `z.object`** (refinements are fine) without a field named `kind`: the tool adds `kind` and shows the model every field (with `.describe()` text). Loading the registry throws otherwise.
3. **`description`** starts with the kind's key ("page.update: …") and says what it changes and how to get the ids and text it needs. "Only an admin can apply it." is added for `permission: "admin"`.
4. **`prepare(p, ctx)`** only reads. Throw `ProposalInputError` for anything the model can fix (no such record, a find that isn't there, nothing would change): the message goes back to it as the tool's error and nothing is saved. Return:
   - `before`: a snapshot of what it changes, as it is now (JSON);
   - `targetId` (with the kind's `targetType`) when it changes one record: a newer proposal for the same target supersedes the older one;
   - `view`: title and summary written by the server (the model never writes them), `diff` rows (`format: "markdown"` for long text gets a line diff on the card), `people`, `links` (site paths or outside URLs), `rows` for list kinds;
   - `fileSha256` for kinds built from a room file. **The payload must then name the file as `fileId`**: Apply compares that `JackFile`'s sha256 and status (READY) and goes STALE if it changed.
5. **`checkStale(p, before)`** returns why it's stale (shown to officers and Jack) or null.
6. **`apply(p, ctx)`** makes the change through the same service the admin page uses, and returns `{ summary, links?, created?, appliedRows?, counts? }`; the first site link becomes the note's link. `ctx` carries:
   - `officer`: who pressed Apply (the audit actor);
   - `before`: the snapshot `checkStale` just passed. Make the write conditional on it where you can (the page service's `expected`), and throw `StaleProposalError` when that write misses, so the proposal goes STALE instead of FAILED;
   - `auditMetadata`: pass it to the service's own audit entry for the change, so the change links back to the proposal;
   - `idempotencyKey` (`proposal:<id>`) for outside services;
   - `selectedRows`: for list kinds (`list.rows`), the row ids the officer left checked; undefined means every row. The framework records them as `appliedRows` unless the kind does.
   Anything else thrown marks it FAILED with the message (redacted). Revalidation lives in the service the kind calls, as it does for the admin page.
7. Set `destructive: true` when applying can't be taken back (sends, posts, deletes): the card asks first.
8. Test it like `page-update.test.ts` (mocked Prisma and service). The framework's own behavior (claims, notes, expiry) is covered once, in `service.test.ts`.

### Database change (additive)

**One new nullable column, `JackProposal.view` (JSONB)**, in `prisma/migrations/20261023041400_jack2_proposal_view`. It saves the card a kind built when proposing; the card can't be rebuilt later because the records it describes may have changed. Applied locally with `prisma migrate deploy`; `migrate diff --exit-code` against a throwaway shadow database reports no difference. JackProposal's RLS policy and `jack_readonly`'s table grant cover it.

### Env vars and setup

None new. The sweep job (`proposals.sweep`, every 10 minutes, Central) is registered for the scheduler (G3); like every job it starts switched off until an officer turns it on. Without it, expiry still works (lazily); only applies that died partway stay APPLYING until it runs.

### Try it locally

- `pnpm --filter @lsr/platform exec tsx scripts/try-jack-proposal.ts` puts a `page.update` card in a new room "Proposal check" (default page: the LSC rules; `--page=<slug>`, `--room=<id>`, `--as=<email|handle>`). A scripted fake Claude answers through the real reply loop and calls `propose_change`, so nothing is spent. Open the printed room, then Apply or Discard; Admin → Pages shows the edit, Jack → Proposals the outcome. Without `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the env it can't broadcast; reload the room.
- `pnpm --filter @lsr/platform exec tsx scripts/check-jack-proposals.ts` checks the framework against the local Postgres: five Applies at once (exactly one wins), superseding, staleness, lazy expiry, discard and the notes. It uses a test kind (no club data), and deletes its room, proposals, notes and audit entries.
- Unit tests: `src/server/jack/proposals/*.test.ts`, `src/server/jack/tools/propose.test.ts`, `src/server/services/page.service.test.ts`, `src/lib/jack/line-diff.test.ts`, `src/lib/jack/proposals.test.ts`, the route and action tests.
