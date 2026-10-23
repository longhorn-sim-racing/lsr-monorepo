# Knowledge seed files

The knowledge base starts with a reviewed set of entries: the club, who does what, decisions, policies, the brand, sponsors, the events playbook, recruiting, which services exist and who holds access (names only), and the calendar rhythm (design §9).

**This repo is public, so seed files are never committed.** Only this README is. Keep the drafts in a private folder outside the repo; the default is `~/.lsr/jack-knowledge-seed/`. The loader refuses a folder inside the repo, and `.gitignore` keeps a stray `jack-knowledge-seed/` folder (or anything else in this folder) out of git.

## The format

One entry per `.md` file. Subfolders are fine (`policies/dues.md`); a file named `README.md` is skipped.

```markdown
---
title: LSC entry fee for Season 3
tags: [lsc, fees, decision]
sourceNote: Competition team post in Teams General, Sep 28
sourceDate: 2026-09-28
owner: armando-martinez
---

The Season 3 entry fee is $10, or $5 for drivers who raced Season 2. There are no membership dues this semester.
```

| Field | Required | What it is |
|---|---|---|
| `title` | yes | 3 to 120 characters, specific enough to find ("LSC entry fee for Season 3", not "Fees"). It's also how a later load finds the same entry, so keep it stable. |
| `tags` | yes | At least one: `[a, b]`, `a, b`, or a `- item` list. Lowercase words joined by dashes; a decision gets `decision` (one entry per decision). |
| `sourceNote` | yes | Where it came from: "Teams General, Dylan, Sep 28", "Drive: Sponsor packet", "docs/payments.md". |
| `sourceDate` | yes | The date the source said it, `YYYY-MM-DD` (Central). |
| `owner` | no | The handle of the officer who keeps it current. |

The text after the front matter is Markdown, at most 20,000 characters. Keep each entry to one topic.

## What the lint refuses

- a missing or malformed field, or an unknown one (a typo like `sourcenote`);
- an email address anywhere: name the role or the page instead ("the Business lead", "the Contact page");
- anything that looks like a key, token or password (`sk_`, `rk_`, `whsec_`, `re_`, `Bot …`, private keys, long random strings, `password: …`). Say where a secret is kept ("in Vercel's env settings"), never the secret;
- two files with the same title.

Gray's private notes are never used as a source.

## Loading

From the repo root:

```bash
# Lint only (and, with DATABASE_URL set, show what would be created or updated)
pnpm --filter @lsr/platform exec tsx scripts/jack-knowledge-seed.ts --dir ~/.lsr/jack-knowledge-seed

# After Gray's sign-off: load, reviewed as of the sign-off date, credited to whoever runs it
pnpm --filter @lsr/platform exec tsx scripts/jack-knowledge-seed.ts --approved=2026-10-25 --actor gray-marshall
```

- Nothing is written without `--approved`, and nothing loads unless every file passes the lint.
- Entries load as `sourceType SEED`, reviewed as of the approval date, each with a version and an audit entry.
- Running it again is safe: an entry whose title matches an earlier load is updated only if something changed (a new version for new text), and left alone otherwise. Similar existing entries are listed but don't block a load.
- Seed entries that are no longer in the folder are listed, never deleted; archive them on the Knowledge page.
- It loads into the database `DATABASE_URL` points at. Loading production is a release step Gray runs; the sign-off is recorded in `docs/jack-2/build-log.md`.
