Docs and env notes for the memory track; folded into docs/jack.md at the end.

# Memory: the knowledge base and officer profiles (T2)

Design §9 (knowledge), §3.3 (officer profiles) and §13 (Knowledge page, profile editor and Members edit). Code paths are relative to `apps/platform/`.

**New env vars:** none. **Migrations:** none (the tables and columns are G1's).

## The knowledge base

A `KnowledgeEntry` is one thing the club wants remembered: a decision, a how-to, a policy, who does what. Title, Markdown body and tags; where it came from (`sourceType` MANUAL / JACK / SEED, `sourceNote`, `sourceDate`, `sourceUrl`); an owner who keeps it current; review and archive dates.

Everything goes through `src/server/jack/knowledge/service.ts`, from the page, Jack's tool and the seed loader alike:

- **Versions.** Every change to the title, body or tags writes a `KnowledgeEntryVersion`. A change to the source or owner only updates the entry.
- **Base version.** An update can name the version it was made from (`baseVersionId`). The entry's row is locked (`FOR UPDATE`), and if a newer version exists the update is refused with the current text instead of overwriting it. Jack's updates must name one; the page always sends the version the form was opened at.
- **Secrets.** Nothing that `findSecret()` (`src/lib/redact.ts`) flags is saved, in any field.
- **Duplicates.** A new entry is compared with every entry that isn't archived, using Postgres's english lexemes (stemmed, without stop words; the search index's vector when it has one). It's refused, with the close entries, when the titles are mostly the same (Jaccard ≥ 0.6), one text is mostly inside the other (≥ 0.7 with 5+ shared), or the texts are mostly the same (Jaccard ≥ 0.45 with 3+ shared), unless the caller names those entries in `notDuplicateOf`. The thresholds are `DUPLICATE_THRESHOLDS` in `similarity.ts`.
- **Review.** Jack's saves are never reviewed, and Jack's text changes clear an entry's review. "Not reviewed" means `reviewedAt` is null and Jack wrote a version of it. An officer marks an entry reviewed on its page (or ticks "Mark reviewed" when saving).
- **Age** = now − (reviewedAt ?? sourceDate ?? updatedAt). Over 180 days it's flagged (`KNOWLEDGE_STALE_DAYS`), and the prompt tells Jack to mention it.
- **Archive** hides an entry (search should leave it out) and keeps its history; **delete** removes it and every version for good (the search index row goes by trigger). Only admins delete.
- **Audit.** Every change writes an audit entry (`entityType` KNOWLEDGE_ENTRY) with titles and tags but never bodies, so a hard delete leaves no copy of the text. The audit page links to the entry.

`src/lib/jack/knowledge.ts` has the shared pure pieces: limits, tags (`normalizeTags`), age, provenance parsing, exact text edits.

## Jack's `knowledge` tool

`src/server/jack/tools/knowledge.ts`, registered in `tools/registry/memory.ts`, always loaded. One tool, three actions: `save`, `update` (id + `baseVersionId`; the whole `body` or exact `edits`) and `archive` (only when asked). Searching and reading go through `search` and `read` (club-data track).

The fence around it (design §9):

- **Only in replies to messages officers typed.** The reply loop now gives each tool call `ctx.reply` (`JackReplyState` in `tools/types.ts`): `fromOfficer` is true only when every message the reply answers is an officer's own (kind `user`), so a reply to a deck continue note can't save, and neither can scripts, which have no `ctx.reply`. Recurring questions and the digest must not set it either.
- **At most 3 changes per reply** (saves, updates and archives together). `ctx.reply.knowledgeChanges` is shared by every call in the reply and counted before the first await, so parallel calls in one turn can't all slip under the cap. A change that doesn't happen (refused, failed) gives its count back.
- **A room note for every change, with the full text** ("Saved in knowledge for Dylan: “Title” (not reviewed yet)", then the text and tags). Notes reach the history, so Jack and everyone in the room see exactly what was kept. Room notes now show any lines after the first under the summary line (`components/jack/room-view.tsx`).
- **Provenance.** Each save or update records the room, the reply, the officer messages it answered, who asked, and the tools the reply used before it (name, input cut to 200 characters, and what came back), so an officer can see whether anything came from an outside source.
- Defaults: the owner and the source note are the officer who asked; the source date is now. Owners must be officers.
- What Jack hears back: the entry's id, `versionId` and link; on a duplicate, the close entries and what to do; on a stale base, the current text and version.

The prompt slot (`prompt-sections/memory.ts`) holds the rules in short; the core prompt (G1) already says Jack saves knowledge only for officers and never from outside sources. `describe_schema` gets notes on the two tables and the profile columns.

## The Knowledge page (Content → Knowledge)

- `/admin/knowledge`: tabs from the tab registry (`_tabs/`); the memory track's tab is **Entries**: search (the search index, plus a plain match on titles and tags), views All / Not reviewed / Over 6 months old / Archived with counts, 50 to a page.
- `/admin/knowledge/new` and `/admin/knowledge/[id]`: the entry form (title, Markdown text, tags, owner, source note, date and link, "Mark reviewed"); a new entry that looks like an existing one asks first ("Save anyway"); an edit on an old version is refused with a "Load the latest" notice. The entry page shows its status and age, details, **Where Jack got it** (provenance), and the **History** (view any version, restore it as a new one). Header buttons: Mark reviewed, Archive / Unarchive, Delete (admins).
- Actions (`app/admin/knowledge/actions.ts`): officers write, edit, review, archive and restore; only admins delete.

## Digest checks

`automation/checks/memory.ts`: **Knowledge Jack saved, not reviewed yet** (a warning once one has waited two weeks) and **Knowledge over 6 months old** (info). Both link to the matching view.

## Officer profiles

Columns on `User` (G1): `department` (the About page roster's team ids: executive, business, community, competition, media, technology), `isBoard`, `workingOn` (one line, 160 characters at most). Validation is `src/schemas/officer-profile.schema.ts`.

- **Self profile editor** (`/drivers/<handle>/edit`): officers get a fifth step, "Officer profile". Non-officers never see it, and the action ignores those fields from them.
- **Members edit** (`/admin/users/<id>/edit`): an "Officer profile" section for officers and admins, saved by `updateUser` and audited with the rest (who can edit whom is unchanged: only admins edit officers).
- **`club_members`**: the officers roster now has handle, department, board seat, what they work on, major and grad year (empty fields left out, so it stays within the tool's size caps), and the room's table shows department and what they work on.
- **Backfill:** `scripts/sync-officer-badges.ts` also sets department and board seat from `src/app/about/roster.ts` for every mapped officer, and clears them (with the badge) for people who are no longer on the roster. "What I work on" is the officer's own and never touched. Dry run by default:

  ```bash
  DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts
  DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts --apply --actor you@utexas.edu
  ```

## Seed tooling

The format is in `docs/jack-2/knowledge-seed/README.md`. **The repo is public, so seed files are never committed**: they live in `~/.lsr/jack-knowledge-seed/` (the loader refuses a folder inside the repo, and `.gitignore` covers `jack-knowledge-seed/` anywhere and everything in `docs/jack-2/knowledge-seed/` but the README). No seed content is in this PR.

`scripts/jack-knowledge-seed.ts` lints every file (`src/server/jack/knowledge/seed.ts`: required fields, dates, sizes, no emails, keys or tokens, unique titles), shows the plan when `DATABASE_URL` is set, and loads only with `--approved[=YYYY-MM-DD] --actor <you>`: `sourceType` SEED, reviewed as of the sign-off date. Reruns update changed entries (a new version for new text) and leave the rest; seed entries missing from the folder are listed, never deleted.

## Setup steps (release)

1. After the migrations reach production: run the officer badge sync with `--apply` to backfill departments and board seats.
2. After Gray signs off the seed drafts (recorded in `build-log.md`): run the seed loader with `--approved` against production.

## Trying it locally

1. `npx supabase start`, then `pnpm dev` and sign in as an officer.
2. Content → Knowledge → **New entry**: write one, then try saving a second with the same title (it asks first). Edit it in two tabs and save both (the second is refused). Archive, unarchive, restore a version; delete as an admin.
3. In a Jack room, say "Remember that there are no dues this semester". Jack saves it (with `ANTHROPIC_API_KEY`), the room gets a note with the text, and the entry shows **Not reviewed** on the Knowledge page.
4. Your profile → Edit profile → **Officer profile**; then ask Jack "who are the officers and what do they work on?"
5. Seeds: put a couple of fake `.md` files in a folder outside the repo and run the loader on it (dry run, then `--approved` against the local database); delete the entries afterwards on the Knowledge page.

## Checks

- Unit tests: `lib/jack/knowledge.test.ts`, `server/jack/knowledge/{service,similarity,seed}.test.ts`, `server/jack/tools/knowledge.test.ts` (where saves are allowed, the cap with parallel calls, notes, provenance, updates and conflicts), `app/admin/knowledge/actions.test.ts` (permissions), `schemas/officer-profile.schema.test.ts`, `server/actions/users.test.ts`, `app/drivers/[handle]/edit/actions.test.ts`, `server/jack/tools/club-members.test.ts`, and a reply-loop test for `ctx.reply`.
- Against the local database: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @lsr/platform exec tsx scripts/check-jack-knowledge.ts` runs the duplicate SQL, search, versions under the row lock (two edits at once: one wins), the views, the page's reads, the digest checks and hard delete, then deletes everything it wrote.
