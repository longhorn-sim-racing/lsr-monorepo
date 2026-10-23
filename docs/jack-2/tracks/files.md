# Files (G5): Supabase Storage and room uploads

Docs for the groundwork PR G5 (design §2.1 and §5), kept in their own file so the groundwork PRs don't collide; fold into `groundwork.md` (and then `docs/jack.md`) at the end. Code paths are relative to `apps/platform/`.

What's here: Jack's file store moves to Supabase Storage, and officers can attach files in rooms. Not here yet (G6): files going to Claude (Files API, turn blocks), the `room_files` tool, room photos in decks, and who's asking.

## The file store
`jackFileStore()` (`src/server/jack/decks/storage.ts`) keeps deck renders, exports and screenshots, and room files. Every backend has get, put, head, delete, list and signed read links; Supabase also signs one-path uploads for the browser.

| Store | When | Notes |
|---|---|---|
| `supabase` | **Default** when `SUPABASE_SERVICE_ROLE_KEY` and a hosted `NEXT_PUBLIC_SUPABASE_URL` are set (production has both) | Private bucket `jack`, service-role key on the server only. No operation cap (Blob on Hobby allows 2,000 writes a month). |
| `blob` | Vercel Blob env set and no hosted Supabase | Kept for a later move to Pro. Decks only: it can't sign browser uploads, so room uploads say they need Supabase. |
| `files` | Neither, and not on Vercel. Also local Supabase (127.0.0.1, localhost) unless `JACK_FILE_STORE=supabase` | `.jack-renders/` on disk. Room uploads go through a local route (below). |
| `none` | On Vercel with nothing set | Renders aren't cached; uploads and screenshots don't work. |

`JACK_FILE_STORE=supabase|blob|files` picks one; a choice that isn't configured falls back to the default with a warning. Local Supabase isn't picked on its own because it needs the bucket made first (and, on Gray's machine, the index fix below): most developers have the service key for broadcasts, and their deck screenshots and render cache would otherwise break.

A missing object reads as "not there" (`get` and `head` return null). A missing bucket throws ("Bucket not found"), so a store that was never set up fails loudly instead of looking empty. Checked against the local storage-api 1.79.36: it answers a missing object with `{statusCode:"404", error:"not_found", message:"Object not found"}` and a missing bucket with `{statusCode:"404", error:"Bucket not found"}`.

Paths in the bucket are the same keys as before (`jack/renders/…`, `jack/exports/…`, `jack/assets/…`), plus room files under `rooms/<roomId>/<fileId>/<name>` and their copies under `rooms/<roomId>/<fileId>/derived/{model,thumb}.jpg`.

### Supabase Free limits (checked 10/22 on supabase.com/pricing and the Storage file-limits guide)
- **Storage: 1 GB** included. Renders are re-makeable caches; the room-file cleanup job deletes unsent files.
- **Per file: 50 MB.** "For Free projects, the limit can't exceed 50 MB" (the global limit; a bucket can only set less). Room uploads stop at **25 MB**; the bucket is set to 50 MB so big deck exports fit.
- Egress: 5 GB a month on Free.
- Signed upload URLs are valid for 2 hours (Supabase's fixed lifetime); upsert stays off, so a URL can create its one path and never overwrite it.

### Release gate: before jack-2 merges to main
The production upload path has not run end to end yet. The end-to-end check below ran with the files store, and the Supabase backend is tested against a fake of Storage's REST API. Merging jack-2 makes Supabase the store for deck renders, exports and screenshots too, so this is a gate, not a follow-up:
1. Get a Storage where uploads work: apply the index fix (under "Trying it locally") to local Storage as `supabase_admin`, or use a hosted Supabase branch or project.
2. `tsx scripts/jack-storage-setup.ts` against it.
3. Run the server and `check-jack-files.ts` with `JACK_FILE_STORE=supabase` on **both** (every check must pass), then attach one file in a browser (the cross-origin PUT, progress, register).
4. With the same server: `/api/admin/jack/render-check`, then render, export and screenshot one deck, all against the Supabase store.

Already checked against the local storage-api 1.79.36, without the index fix (so nothing could be stored): `createSignedUploadUrl` signs a path; the browser's request (a PUT with the file in a form, `x-upsert: false`, `apikey`, an `Origin`) passes the CORS preflight (`Access-Control-Allow-Origin: *`, `apikey,x-upsert` allowed) and reaches the database write, where it stops with the known 42P10; the bucket's allow-list is enforced on the form part's type (`text/csv` into a bucket without it: 415 `invalid_mime_type`, which the chip shows as "Storage doesn't take this type of file"); `head`/`get` answer null for a missing object and throw for a missing bucket.

### Setup (production, a release step for Gray)
1. **Before deploying**, with production's `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment:
   `pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts --dry-run`, then without `--dry-run`. It creates (or updates) the bucket: private, 50 MB per file, an allow-list of the types Jack stores. It prints the project host first. Until the bucket exists, every store call fails with "Bucket not found": renders and exports are still made (uncached, with the error in the function log), but deck screenshots and room uploads fail, and render-check shows it.
2. Copy the stored screenshots slides point at: add `--copy-from-blob` (needs `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` with a fresh `VERCEL_OIDC_TOKEN` from `vercel env pull`). Renders and exports aren't copied; they're made again on first view.
3. Deploy. Check `/api/admin/jack/render-check` shows `"store": { "kind": "supabase", "ok": true }`.
4. Turn on the `files.cleanup` job on the Scheduled jobs page once G3 is in.

No new env vars in production: `SUPABASE_SERVICE_ROLE_KEY` exists already (Jack broadcasts with it). The browser sends the public `NEXT_PUBLIC_SUPABASE_ANON_KEY` as `apikey` with its uploads, as supabase-js does.

## Attaching files in a room
1. The composer (attach button, paste, drag and drop) checks each file with the same rules the server uses (`src/lib/jack/files.ts`) and shows a chip: name, size, progress, error, remove, a preview for photos.
2. `createJackUpload({ roomId, filename, size, type })` (server action, `requireOfficer`) checks the name, type and size, saves the `JackFile` row as UPLOADING and returns a signed upload URL for exactly `rooms/<roomId>/<fileId>/<sanitized name>` (`src/server/jack/files/service.ts`).
3. The browser uploads straight to Supabase Storage with the request `uploadToSignedUrl` sends (a PUT with the file in a form, `x-upsert: false`), through XMLHttpRequest so the chip can show progress (`src/lib/jack/upload.ts`). The file goes up typed as the server said, whatever the browser guessed.
4. `POST /api/admin/jack/files/[id]/register` (the uploader only) checks the object arrived whole (size and type), **its magic bytes against its type**, takes its sha256, makes the photo copies, extracts text, and sets READY or FAILED. A refused file's bytes are deleted. It's a route, not a server action: actions run one at a time per tab, and reading a big PDF would hold up the room.
5. Send waits for the uploads in the composer when it was pressed, then `postJackMessage(roomId, content, fileIds)` posts up to 10 READY files of the poster's in this room (the text may be empty). They're claimed in the message's transaction, so two tabs can't post the same file. Files attached while Send waits aren't part of that message; they stay in the composer for the next one. Messages show photos as thumbnails and other files as tiles; a click opens the file.

Removing a chip deletes the file and its copies (`removeJackUpload`). Each officer can have 20 unsent files per room per day. Pasting text copied from Excel or Word pastes the text: Office also puts a picture of the selection on the clipboard, and a paste that has text and only images attaches nothing. A screenshot or copied photo (no text) is attached.

The room's server actions import `service.ts` (create and remove); registration lives in `register.ts`, which only the register route imports, so the actions never load pdf.js, sharp, exceljs or mammoth (a test checks).

### What's allowed
- **Taken:** JPEG, PNG, WebP, GIF; PDF; CSV, XLSX; JSON; TXT, Markdown; VTT; DOCX. The extension decides the type; a declared type that contradicts it is refused (browsers' usual alternatives, like Windows calling CSV `application/vnd.ms-excel`, are fine).
- **Refused with a reason:** SVG, HTML/XHTML/XML (can carry scripts), macro files (`.xlsm`, `.docm`…), archives, programs and scripts.
- **HEIC/HEIF: refused** with "export it as JPEG". The installed sharp (0.35.5, prebuilt libvips 8.18) has libheif with AV1 only: `sharp.format.heif.input.fileSuffix` is `[".avif"]`, and saving HEVC fails with "Unsupported compression". The prebuilt binaries leave HEVC out for patent reasons; supporting HEIC would mean a custom libvips build.

### Checks at registration (`src/server/jack/files/magic.ts`, `zip.ts`)
- Images must start with their format's signature (a PNG that's really a JPEG is refused, naming what it looks like; an HEIC renamed `.jpg` gets the export hint).
- PDFs need `%PDF-` in the first 1,024 bytes.
- DOCX and XLSX must be ZIPs with the right part inside (`word/document.xml`, `xl/workbook.xml`); `vbaProject.bin` (macros) and `xl/workbook.bin` (`.xlsb`) are refused. The ZIP is read the way Word, Excel and JSZip read it, from the central directory, and each entry is checked against its local header: entries must tile the file in order with no gaps or overlaps, under the same names. An archive whose central directory and local headers disagree (an entry hidden inside another's data, two records sharing data, a local entry the directory leaves out) is refused as damaged, so the macro check and the size count see what any reader sees. Every entry is inflated with a running count and stopped at **100 MB or 5,000 entries** (declared sizes aren't trusted).
- mammoth and exceljs never open the upload itself. Extraction takes out only the parts they read, each capped (below), and packs them into a fresh archive (`readZipParts`, `packZip`); entries they don't read are never inflated.
- Text kinds must be text (no NUL bytes; UTF-8, UTF-16 with a BOM, or Windows-1252), JSON must parse, VTT must start with `WEBVTT`.

### Copies and text (`images.ts`, `extract.ts`)
- **Photos:** a model copy (JPEG, upright from EXIF, every bit of metadata stripped, long edge at most 2000 px) and a 320 px thumbnail made from the model copy, both with sharp, so the original is decoded once; at most 70 megapixels in (decompression bombs). Width and height are saved.
- **Text**, capped at 200,000 characters: CSV (header plus 5,000 rows), JSON (pretty-printed), text and Markdown, VTT as speaker-tagged turns (`[1:23] Dylan: …`, from Teams' `<v Name>` or Zoom's `Name:`), DOCX, XLSX (every sheet, 5,000 rows in all, formulas give their **saved** result and are never evaluated, dates as dates), PDF (pdf.js 6, page by page, 300 pages, with the page count).
- **XLSX memory:** exceljs's streaming reader, row by row, over a fresh archive of the workbook, its relationships and styles, the shared strings (16 MB of XML) and the sheets (16 MB of XML together; past that only the start is read, `truncated`). They're packed in the order the reader needs (strings before sheets; an empty string table when there's none), so it never spills sheets to temporary files, and it stops at the row cap. Measured with a 250,000-row lap export (15.6 MB, 98 MB unpacked): peak memory up about 110 MB, where `load()` took 1.1 GB.
- **DOCX memory:** mammoth builds the whole document twice over in memory, about 60 times its XML (measured: 3.8 MB of XML took 350 MB, 19 MB took 1.2 GB). It only gets documents up to **2 MB** of XML (notes and comments included). Bigger ones are read straight from the XML: paragraphs, tabs and breaks, deleted text and field codes left out (`wordText`), the first 16 MB of it.
- Time limit 25 s. At 80% of it the readers stop between pages (PDF) or rows (XLSX) and keep what they read (`timeout`); at the limit they're told to quit (pdf.js's task is destroyed), so nothing runs on after the answer. A Word document's parse can't be stopped midway; its 2 MB cap keeps it to about a second.
- `textStatus`: `ok`, `truncated`, `timeout`, `none` (photos, scanned PDFs), `failed` (the parser couldn't read it; the file is still READY).
- Not in a worker thread: Next 16.1's Turbopack copies a `new Worker(new URL("./worker.ts", import.meta.url))` target into the build as a raw asset (checked with a probe build: `.next/server/assets/worker.<hash>.ts`), not a bundled entry, so a worker would have to be a hand-written, unbundled `.mjs` whose imports Vercel's file tracing doesn't follow. The caps above bound memory instead.
- **pdf.js on Vercel:** `extract.ts` imports `pdf.worker.mjs` statically and sets `globalThis.pdfjsWorker`, so file tracing ships the worker; `next.config.ts` also lists it in `outputFileTracingIncludes` for `/api/admin/jack/**`.

### Serving (`GET /api/admin/jack/files/[id]`)
Officers only, by id (never by path), READY files only. `?variant=original|model|thumb`. Headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store` (thumbnails `private, max-age=31536000, immutable`), `Content-Disposition: attachment` except raster images (with an ASCII name plus the real one encoded, so a name can't break the header). Over 4 MB: a redirect to a one-minute signed link (a download link for non-images).

## Cleanup job
`files.cleanup` (`src/server/scheduler/jobs/files.ts`, daily at 4:15 AM Central, off by default like every job) deletes uploads still UPLOADING after 24 hours and files never posted after 7 days, with their stored copies, 200 per run. Posted files and meeting transcripts are never touched; each row is checked again as it's deleted, so a file posted meanwhile keeps its bytes. A file's photo-copy paths are always deleted, recorded or not (registration stores the copies before it records them). If the store won't delete the copies, the run fails.

Then it sweeps `rooms/` for stored files no row points at (`sweepOrphanFiles`) and deletes them when they're a day old: an upload that landed after its file was removed (a signed upload link works for 2 hours), copies a failed delete left behind. A file's row is always saved before anything is stored for it, so an object without one is a leftover. Deck files (`jack/…`) are never touched. Registration also deletes the photo copies it just stored when the file was removed while it was being checked.

## Trying it locally
- **The default locally is the files store** (below), even with `SUPABASE_SERVICE_ROLE_KEY` set.
- **With local Supabase Storage:** set `JACK_FILE_STORE=supabase`, create the bucket with `tsx scripts/jack-storage-setup.ts`, start the app, open a room, attach files.
  - **On Gray's machine, uploads to local Storage fail** with `database error, code: 42P10`: the local `storage.objects` indexes `idx_objects_current_version` and `idx_objects_null_version` were created without `COLLATE "C"` (by an older CLI), and storage-api 1.79 upserts with that collation. Fix (local only, the table is empty): as `supabase_admin`, drop both and recreate them as in storage-api's migrations 0066/0067: `CREATE UNIQUE INDEX idx_objects_current_version ON storage.objects (bucket_id, name COLLATE "C") WHERE archived_at IS NULL;` and `CREATE UNIQUE INDEX idx_objects_null_version ON storage.objects (bucket_id, name COLLATE "C") WHERE NOT is_versioned;`. Or use the files store.
- **With the files store:** everything is kept in `.jack-renders/`, and the browser uploads to `PUT /api/admin/jack/files/[id]/upload` (development stand-in for the signed URL: the uploader's own UPLOADING file, once; 404 with any other store).
- **End-to-end check:** `pnpm --filter @lsr/platform build`, then `JACK_FILE_STORE=files pnpm --filter @lsr/platform start -p 3115`, then `tsx scripts/check-jack-files.ts --base-url=http://localhost:3115`. It signs in a throwaway officer, uploads a PDF, DOCX, XLSX (and one over the row cap), VTT, CSV and a photo through the real routes, checks the text, the copies, the refusals and the headers, posts a message with them (fake Claude), and deletes everything it made.

## Tests
`src/lib/jack/files.test.ts` (allow-list, names), `upload.test.ts` (the upload request, errors, pastes from Office), `upload-queue.test.ts` (files added while Send waits stay), `src/server/jack/files/*.test.ts` (magic bytes; `zip.test.ts`: zip bombs and archives whose central directory and local headers disagree, built by hand; extraction caps, a 20,000-row spreadsheet read from a capped slice, the time limit, Word documents too big for mammoth; photo copies; the register flow against an in-memory store, including a file removed while it's checked; attaching; cleanup selection, unrecorded copies, the orphan sweep and the job), `src/server/jack/decks/storage.test.ts` (store selection, the Supabase backend against a fake of Storage's REST API including a missing bucket, the files store), the three route tests, the actions test, and `actions-imports.test.ts` (the actions don't load the parsers).

## Notes for the next PRs
- **G6:** `JackFile.anthropicFileId` is unused yet; uploading PDFs and model copies to the Files API belongs in `registerFile` (after the checks), and the cleanup job should delete Claude Files too. Until G6 changes the turn format, Jack sees an attachment-only message as an empty line. `room_files` can read `text`, `textStatus`, `pageCount` and the model copy through `jackFileStore()`.
- **G2 (done in PR I):** the Connections page's storage panel shows the store in use, the bucket's usage from `storage.objects` against the 1 GB, and room files by status (`src/server/jack/files/usage.ts`; groundwork.md, "The Connections page"). The eval's cleanup deletes room files' objects (and their photo copies) through the store's `delete`.
- **G3:** the job registry joins `jobs/files.ts` into the groundwork slot (`groundwork: [...groundworkJobs, ...filesJobs]`); G4's `jobs/proposals.ts` will want the same line.
