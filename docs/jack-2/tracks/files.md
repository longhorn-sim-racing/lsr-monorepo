# Files (G5): Supabase Storage and room uploads

Docs for the groundwork PR G5 (design §2.1 and §5), kept in their own file so the groundwork PRs don't collide; fold into `groundwork.md` (and then `docs/jack.md`) at the end. Code paths are relative to `apps/platform/`.

What's here: Jack's file store moves to Supabase Storage, and officers can attach files in rooms. Not here yet (G6): files going to Claude (Files API, turn blocks), the `room_files` tool, room photos in decks, and who's asking.

## The file store
`jackFileStore()` (`src/server/jack/decks/storage.ts`) keeps deck renders, exports and screenshots, and room files. Every backend has get, put, head, delete, list and signed read links; Supabase also signs one-path uploads for the browser.

| Store | When | Notes |
|---|---|---|
| `supabase` | **Default** when `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` are set (production has both) | Private bucket `jack`, service-role key on the server only. No operation cap (Blob on Hobby allows 2,000 writes a month). |
| `blob` | Vercel Blob env set and no Supabase | Kept for a later move to Pro. Decks only: it can't sign browser uploads, so room uploads say they need Supabase. |
| `files` | Neither, and not on Vercel | `.jack-renders/` on disk. Room uploads go through a local route (below). |
| `none` | On Vercel with nothing set | Renders aren't cached; uploads and screenshots don't work. |

`JACK_FILE_STORE=supabase|blob|files` picks one; a choice that isn't configured falls back to the default with a warning.

Paths in the bucket are the same keys as before (`jack/renders/…`, `jack/exports/…`, `jack/assets/…`), plus room files under `rooms/<roomId>/<fileId>/<name>` and their copies under `rooms/<roomId>/<fileId>/derived/{model,thumb}.jpg`.

### Supabase Free limits (checked 10/22 on supabase.com/pricing and the Storage file-limits guide)
- **Storage: 1 GB** included. Renders are re-makeable caches; the room-file cleanup job deletes unsent files.
- **Per file: 50 MB.** "For Free projects, the limit can't exceed 50 MB" (the global limit; a bucket can only set less). Room uploads stop at **25 MB**; the bucket is set to 50 MB so big deck exports fit.
- Egress: 5 GB a month on Free.
- Signed upload URLs are valid for 2 hours (Supabase's fixed lifetime); upsert stays off, so a URL can create its one path and never overwrite it.

### Setup (production, a release step for Gray)
1. With production's `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment:
   `pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts --dry-run`, then without `--dry-run`. It creates (or updates) the bucket: private, 50 MB per file, an allow-list of the types Jack stores. It prints the project host first.
2. Copy the stored screenshots slides point at: add `--copy-from-blob` (needs `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` with a fresh `VERCEL_OIDC_TOKEN` from `vercel env pull`). Renders and exports aren't copied; they're made again on first view.
3. Deploy. Check `/api/admin/jack/render-check` shows `"store": { "kind": "supabase", "ok": true }`.
4. Turn on the `files.cleanup` job on the Scheduled jobs page once G3 is in.

No new env vars in production: `SUPABASE_SERVICE_ROLE_KEY` exists already (Jack broadcasts with it). The browser sends the public `NEXT_PUBLIC_SUPABASE_ANON_KEY` as `apikey` with its uploads, as supabase-js does.

## Attaching files in a room
1. The composer (attach button, paste, drag and drop) checks each file with the same rules the server uses (`src/lib/jack/files.ts`) and shows a chip: name, size, progress, error, remove, a preview for photos.
2. `createJackUpload({ roomId, filename, size, type })` (server action, `requireOfficer`) checks the name, type and size, saves the `JackFile` row as UPLOADING and returns a signed upload URL for exactly `rooms/<roomId>/<fileId>/<sanitized name>` (`src/server/jack/files/service.ts`).
3. The browser uploads straight to Supabase Storage with the request `uploadToSignedUrl` sends (a PUT with the file in a form, `x-upsert: false`), through XMLHttpRequest so the chip can show progress (`src/lib/jack/upload.ts`). The file goes up typed as the server said, whatever the browser guessed.
4. `POST /api/admin/jack/files/[id]/register` (the uploader only) checks the object arrived whole (size and type), **its magic bytes against its type**, takes its sha256, makes the photo copies, extracts text, and sets READY or FAILED. A refused file's bytes are deleted. It's a route, not a server action: actions run one at a time per tab, and reading a big PDF would hold up the room.
5. Send waits for uploads still going, then `postJackMessage(roomId, content, fileIds)` posts up to 10 READY files of the poster's in this room (the text may be empty). They're claimed in the message's transaction, so two tabs can't post the same file. Messages show photos as thumbnails and other files as tiles; a click opens the file.

Removing a chip deletes the file and its copies (`removeJackUpload`). Each officer can have 20 unsent files per room per day.

### What's allowed
- **Taken:** JPEG, PNG, WebP, GIF; PDF; CSV, XLSX; JSON; TXT, Markdown; VTT; DOCX. The extension decides the type; a declared type that contradicts it is refused (browsers' usual alternatives, like Windows calling CSV `application/vnd.ms-excel`, are fine).
- **Refused with a reason:** SVG, HTML/XHTML/XML (can carry scripts), macro files (`.xlsm`, `.docm`…), archives, programs and scripts.
- **HEIC/HEIF: refused** with "export it as JPEG". The installed sharp (0.35.5, prebuilt libvips 8.18) has libheif with AV1 only: `sharp.format.heif.input.fileSuffix` is `[".avif"]`, and saving HEVC fails with "Unsupported compression". The prebuilt binaries leave HEVC out for patent reasons; supporting HEIC would mean a custom libvips build.

### Checks at registration (`src/server/jack/files/magic.ts`, `zip.ts`)
- Images must start with their format's signature (a PNG that's really a JPEG is refused, naming what it looks like; an HEIC renamed `.jpg` gets the export hint).
- PDFs need `%PDF-` in the first 1,024 bytes.
- DOCX and XLSX must be ZIPs with the right part inside (`word/document.xml`, `xl/workbook.xml`); `vbaProject.bin` (macros) and `xl/workbook.bin` (`.xlsb`) are refused. The ZIP is inflated once with a running count and stopped at **100 MB or 5,000 entries**, so a zip bomb never reaches mammoth or exceljs (declared sizes aren't trusted).
- Text kinds must be text (no NUL bytes; UTF-8, UTF-16 with a BOM, or Windows-1252), JSON must parse, VTT must start with `WEBVTT`.

### Copies and text (`images.ts`, `extract.ts`)
- **Photos:** a model copy (JPEG, upright from EXIF, every bit of metadata stripped, long edge at most 2000 px) and a 320 px thumbnail, both with sharp; at most 70 megapixels in (decompression bombs). Width and height are saved.
- **Text**, capped at 200,000 characters: CSV (header plus 5,000 rows), JSON (pretty-printed), text and Markdown, VTT as speaker-tagged turns (`[1:23] Dylan: …`, from Teams' `<v Name>` or Zoom's `Name:`), DOCX (mammoth), XLSX (exceljs, every sheet, 5,000 rows in all, formulas give their **saved** result and are never evaluated), PDF (pdf.js 6, page by page, 300 pages, with the page count).
- Time limit 25 s. `textStatus`: `ok`, `truncated`, `timeout`, `none` (photos, scanned PDFs), `failed` (the parser couldn't read it; the file is still READY).
- **pdf.js on Vercel:** `extract.ts` imports `pdf.worker.mjs` statically and sets `globalThis.pdfjsWorker`, so file tracing ships the worker; `next.config.ts` also lists it in `outputFileTracingIncludes` for `/api/admin/jack/**`.

### Serving (`GET /api/admin/jack/files/[id]`)
Officers only, by id (never by path), READY files only. `?variant=original|model|thumb`. Headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store` (thumbnails `private, max-age=31536000, immutable`), `Content-Disposition: attachment` except raster images (with an ASCII name plus the real one encoded, so a name can't break the header). Over 4 MB: a redirect to a one-minute signed link (a download link for non-images).

## Cleanup job
`files.cleanup` (`src/server/scheduler/jobs/files.ts`, daily at 4:15 AM Central, off by default like every job) deletes uploads still UPLOADING after 24 hours and files never posted after 7 days, with their stored copies, 200 per run. Posted files and meeting transcripts are never touched; each row is checked again as it's deleted, so a file posted meanwhile keeps its bytes. If the store won't delete the copies, the run fails (the rows are gone, so it says the copies are orphaned).

## Trying it locally
- **With local Supabase Storage** (the default): create the bucket with `tsx scripts/jack-storage-setup.ts`, start the app, open a room, attach files.
  - **On Gray's machine, uploads to local Storage fail** with `database error, code: 42P10`: the local `storage.objects` indexes `idx_objects_current_version` and `idx_objects_null_version` were created without `COLLATE "C"` (by an older CLI), and storage-api 1.79 upserts with that collation. Fix (local only, the table is empty): as `supabase_admin`, drop both and recreate them as in storage-api's migrations 0066/0067: `CREATE UNIQUE INDEX idx_objects_current_version ON storage.objects (bucket_id, name COLLATE "C") WHERE archived_at IS NULL;` and `CREATE UNIQUE INDEX idx_objects_null_version ON storage.objects (bucket_id, name COLLATE "C") WHERE NOT is_versioned;`. Or use the files store.
- **With the files store:** `JACK_FILE_STORE=files` keeps everything in `.jack-renders/`, and the browser uploads to `PUT /api/admin/jack/files/[id]/upload` (development stand-in for the signed URL: the uploader's own UPLOADING file, once; 404 with any other store).
- **End-to-end check:** `pnpm --filter @lsr/platform build`, then `JACK_FILE_STORE=files pnpm --filter @lsr/platform start -p 3115`, then `tsx scripts/check-jack-files.ts --base-url=http://localhost:3115`. It signs in a throwaway officer, uploads a PDF, DOCX, XLSX, VTT, CSV and a photo through the real routes, checks the text, the copies, the refusals and the headers, posts a message with them (fake Claude), and deletes everything it made.

## Tests
`src/lib/jack/files.test.ts` (allow-list, names), `upload.test.ts` (the upload request, errors), `src/server/jack/files/*.test.ts` (magic bytes, zip bombs, extraction caps, photo copies, the register flow against an in-memory store, attaching, cleanup selection and the job), `src/server/jack/decks/storage.test.ts` (store selection, the Supabase backend against a fake of Storage's REST API, the files store), the three route tests, and the actions test.

## Notes for the next PRs
- **G6:** `JackFile.anthropicFileId` is unused yet; uploading PDFs and model copies to the Files API belongs in `registerFile` (after the checks), and the cleanup job should delete Claude Files too. Until G6 changes the turn format, Jack sees an attachment-only message as an empty line. `room_files` can read `text`, `textStatus`, `pageCount` and the model copy through `jackFileStore()`.
- **G2:** the Connections page's storage panel can show usage from `storage.objects` (`sum((metadata->>'size')::bigint) WHERE bucket_id = 'jack'`) against the 1 GB.
- **G3:** the job registry joins `jobs/files.ts` into the groundwork slot (`groundwork: [...groundworkJobs, ...filesJobs]`); G4's `jobs/proposals.ts` will want the same line.
