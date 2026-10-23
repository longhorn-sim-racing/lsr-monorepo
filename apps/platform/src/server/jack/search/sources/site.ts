import { Prisma } from "@prisma/client"
import { getEffectiveEventStatus, isEventPublic } from "@/lib/events"
import { prisma } from "@/server/db"
import { ct } from "../../tools/time"
import { albumHref, eventHref, instagramHref, pageHref, postHref, PUBLIC_PAGE_SLUGS } from "../links"
import { readSitePage } from "../site-page"
import { cleanSnippet, HEADLINE_INPUT_CHARS, HEADLINE_OPTIONS, isoOrNull, queryCte, rankOf } from "../sql"
import type { ReadResult, SearchReader, SearchSource } from "../types"

/**
 * The public site's content (design §7.1): published news posts, content pages the site shows,
 * public events, gallery albums and Instagram posts that aren't hidden. Only what a signed-out visitor
 * can see: drafts, scheduled posts, hidden events and their meeting links are never searched or read.
 * These tables are small, so they're searched with to_tsvector on the fly rather than an index.
 */

type SiteType = "post" | "page" | "event" | "album" | "instagram"

type SiteRow = {
  type: SiteType
  id: string
  title: string
  key: string
  date: Date | null
  rank: number
  snippet: string | null
}

const TYPE_LABEL: Record<SiteType, string> = { post: "News post", page: "Page", event: "Event", album: "Gallery album", instagram: "Instagram post" }

function siteUrl(type: SiteType, key: string): string | null {
  if (type === "post") return postHref(key)
  if (type === "page") return pageHref(key)
  if (type === "event") return eventHref(key)
  if (type === "album") return albumHref(key)
  return instagramHref(key)
}

const notFound = (what: string, id: string): ReadResult => ({ ok: false, error: `No public ${what} ${id}: it may be a draft, hidden, or deleted.` })

/**
 * A post the public sees: public, with a publish date that has passed. The same rule as
 * isPostPublished in lib/news, which isn't imported here: it loads the MDX compiler, and scripts
 * (the eval) load these tools
 */
export function isPublishedPost(post: { publishedAt: Date | null; visibility: string }, now = new Date()): boolean {
  return post.visibility === "public" && !!post.publishedAt && post.publishedAt <= now
}

const readers: SearchReader[] = [
  {
    type: "post",
    description: "a published news post, by id",
    async read(id) {
      const post = await prisma.post.findUnique({
        where: { id },
        select: { id: true, title: true, slug: true, excerpt: true, bodyMd: true, publishedAt: true, visibility: true, author: { select: { displayName: true } } },
      })
      if (!post || !isPublishedPost(post)) return notFound("news post", id)
      return {
        ok: true,
        doc: {
          type: "post",
          id: post.id,
          title: post.title,
          url: postHref(post.slug),
          date: isoOrNull(post.publishedAt),
          meta: { published: ct(post.publishedAt), ...(post.author ? { by: post.author.displayName } : {}) },
          text: [`# ${post.title}`, post.excerpt, post.bodyMd].filter(Boolean).join("\n\n"),
        },
      }
    },
  },
  {
    type: "page",
    description: "a content page the site shows (such as the LSC rules), by id",
    async read(id) {
      const page = await prisma.page.findUnique({ where: { id }, select: { id: true, title: true, slug: true, bodyMd: true, visibility: true, updatedAt: true } })
      const url = page ? pageHref(page.slug) : null
      if (!page || page.visibility !== "public" || !url) return notFound("page", id)
      return { ok: true, doc: { type: "page", id: page.id, title: page.title, url, date: isoOrNull(page.updatedAt), meta: { updated: ct(page.updatedAt) }, text: `# ${page.title}\n\n${page.bodyMd}` } }
    },
  },
  {
    type: "event",
    description: "a public event's details as its page shows them, by id",
    async read(id) {
      const event = await prisma.event.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          slug: true,
          summary: true,
          description: true,
          status: true,
          visibility: true,
          publishedAt: true,
          startsAtUtc: true,
          endsAtUtc: true,
          registrationEnabled: true,
          registrationOpensAt: true,
          registrationClosesAt: true,
          registrationMax: true,
          registrationFeeCents: true,
          series: { select: { title: true } },
          venue: { select: { name: true, room: true, addressLine1: true, city: true, state: true } },
        },
      })
      if (!event || !isEventPublic(event)) return notFound("event", id)
      const venue = event.venue ? [event.venue.name, event.venue.room, [event.venue.addressLine1, event.venue.city, event.venue.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : null
      const registration = event.registrationEnabled
        ? [
            "Takes registrations",
            event.registrationOpensAt ? `opening ${ct(event.registrationOpensAt)}` : null,
            event.registrationClosesAt ? `closing ${ct(event.registrationClosesAt)}` : null,
            event.registrationMax ? `${event.registrationMax} seats` : null,
            event.registrationFeeCents ? `$${(event.registrationFeeCents / 100).toFixed(2)} fee` : "free",
          ]
            .filter(Boolean)
            .join(", ")
        : "No registration"
      const lines = [
        `# ${event.title}`,
        `When: ${ct(event.startsAtUtc)} to ${ct(event.endsAtUtc)}`,
        venue ? `Where: ${venue}` : null,
        event.series ? `Series: ${event.series.title}` : null,
        `Status: ${getEffectiveEventStatus(event)}`,
        `Registration: ${registration}`,
        event.summary,
        event.description,
      ]
      return {
        ok: true,
        doc: {
          type: "event",
          id: event.id,
          title: event.title,
          url: eventHref(event.slug),
          date: isoOrNull(event.startsAtUtc),
          meta: { starts: ct(event.startsAtUtc), ...(event.series ? { series: event.series.title } : {}) },
          text: lines.filter(Boolean).join("\n\n"),
        },
      }
    },
  },
  {
    type: "album",
    description: "a gallery album, by id",
    async read(id) {
      const album = await prisma.galleryAlbum.findUnique({
        where: { id },
        select: { id: true, title: true, slug: true, description: true, date: true, _count: { select: { images: true } }, event: { select: { title: true, status: true, publishedAt: true, visibility: true } } },
      })
      if (!album) return notFound("gallery album", id)
      const event = album.event && isEventPublic(album.event) ? album.event.title : null
      return {
        ok: true,
        doc: {
          type: "album",
          id: album.id,
          title: album.title,
          url: albumHref(album.slug),
          date: isoOrNull(album.date),
          meta: { photos: album._count.images, ...(event ? { event } : {}) },
          text: [`# ${album.title}`, album.date ? `Date: ${ct(album.date)}` : null, `${album._count.images} photos`, event ? `From: ${event}` : null, album.description].filter(Boolean).join("\n\n"),
        },
      }
    },
  },
  {
    type: "instagram",
    description: "an Instagram post's caption, by id",
    async read(id) {
      const post = await prisma.instagramPost.findUnique({ where: { id }, select: { id: true, caption: true, permalink: true, mediaType: true, postedAt: true, hidden: true } })
      const url = post ? instagramHref(post.permalink) : null
      if (!post || post.hidden || !url) return notFound("Instagram post", id)
      return {
        ok: true,
        doc: { type: "instagram", id: post.id, title: `Instagram post, ${ct(post.postedAt)}`, url, date: isoOrNull(post.postedAt), meta: { kind: post.mediaType }, text: post.caption || "(no caption)" },
      }
    },
  },
  {
    type: "site_page",
    description: 'one of the club site\'s public pages, as a signed-out visitor sees it; the id is its path, e.g. "/about" or "/lone-star-cup"',
    async read(id, { signal }) {
      const page = await readSitePage(id, { signal })
      if (!page.ok) return page
      return { ok: true, doc: { type: "site_page", id: page.path, title: page.title ?? page.path, url: page.path, date: null, meta: {}, text: page.text || "(This page has no text.)" } }
    },
  },
]

export const siteSource: SearchSource = {
  key: "site",
  description: "the public website: published news posts, content pages (such as the LSC rules), public events, gallery albums and Instagram posts",
  byDefault: true,
  async search({ query, limit }) {
    const pages = PUBLIC_PAGE_SLUGS.length ? PUBLIC_PAGE_SLUGS : ["\u0000"]
    const rows = await prisma.$queryRaw<SiteRow[]>(Prisma.sql`
      WITH ${queryCte(query)},
      clock AS (SELECT now() AT TIME ZONE 'UTC' AS now),
      docs AS (
        SELECT 'post' AS type, p.id, p.title, p.slug AS key, p."publishedAt" AS date,
          setweight(to_tsvector('english', p.title), 'A') || setweight(to_tsvector('english', coalesce(p.excerpt, '')), 'B') || setweight(to_tsvector('english', left(p."bodyMd", 100000)), 'C') AS doc,
          concat_ws(E'\n\n', p.excerpt, p."bodyMd") AS body
        FROM "Post" p CROSS JOIN clock
        WHERE p.visibility = 'public' AND p."publishedAt" <= clock.now
        UNION ALL
        SELECT 'page', g.id, g.title, g.slug, g."updatedAt",
          setweight(to_tsvector('english', g.title), 'A') || setweight(to_tsvector('english', left(g."bodyMd", 100000)), 'C'),
          g."bodyMd"
        FROM "Page" g
        WHERE g.visibility = 'public' AND g.slug IN (${Prisma.join(pages)})
        UNION ALL
        SELECT 'event', e.id, e.title, e.slug, e."startsAtUtc",
          setweight(to_tsvector('english', e.title), 'A') || setweight(to_tsvector('english', concat_ws(' ', e.summary, s.title)), 'B') || setweight(to_tsvector('english', concat_ws(' ', left(e.description, 100000), v.name)), 'C'),
          concat_ws(E'\n\n', e.summary, e.description)
        FROM "Event" e
        CROSS JOIN clock
        LEFT JOIN "EventSeries" s ON s.id = e."seriesId"
        LEFT JOIN "Venue" v ON v.id = e."venueId"
        WHERE e.visibility = 'public' AND (e.status NOT IN ('DRAFT', 'SCHEDULED') OR (e.status = 'SCHEDULED' AND e."publishedAt" <= clock.now))
        UNION ALL
        SELECT 'album', a.id, a.title, a.slug, a.date,
          setweight(to_tsvector('english', a.title), 'A') || setweight(to_tsvector('english', coalesce(a.description, '')), 'B'),
          coalesce(a.description, a.title)
        FROM "GalleryAlbum" a
        UNION ALL
        SELECT 'instagram', i.id, left(coalesce(nullif(i.caption, ''), 'Instagram post'), 80), i.permalink, i."postedAt",
          setweight(to_tsvector('english', left(coalesce(i.caption, ''), 20000)), 'B'),
          coalesce(i.caption, '')
        FROM "InstagramPost" i
        WHERE i.hidden = false
      ),
      hits AS (
        SELECT d.type, d.id, d.title, d.key, d.date, d.body, ts_rank_cd(d.doc, q.query, 32) AS rank
        FROM docs d CROSS JOIN q
        WHERE d.doc @@ q.query
        ORDER BY rank DESC, d.date DESC NULLS LAST
        LIMIT ${limit}
      )
      SELECT h.type, h.id, h.title, h.key, h.date, h.rank,
        ts_headline('english', left(h.body, ${HEADLINE_INPUT_CHARS}::int), q.query, ${HEADLINE_OPTIONS}) AS snippet
      FROM hits h CROSS JOIN q
      ORDER BY h.rank DESC, h.date DESC NULLS LAST`)
    return rows.flatMap((row) => {
      const url = siteUrl(row.type, row.key)
      if (!url) return []
      return [
        {
          source: "site",
          type: row.type,
          id: row.id,
          title: row.type === "instagram" ? `Instagram: ${row.title.replace(/\s+/g, " ").trim()}` : row.title,
          url,
          snippet: cleanSnippet(row.snippet),
          date: isoOrNull(row.date),
          meta: { kind: TYPE_LABEL[row.type] },
          rank: rankOf(row.rank),
        },
      ]
    })
  },
  readers,
}
