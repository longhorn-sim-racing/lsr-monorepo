import { getAllPosts } from "@/lib/news"
import { getSiteUrl } from "@/lib/site-url"

// Built per request; the CDN keeps each copy for a minute (Cache-Control below)
export const dynamic = "force-dynamic"

function esc(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export async function GET() {
  const site = getSiteUrl()
  const self = `${site}/news/rss.xml`
  let posts: Awaited<ReturnType<typeof getAllPosts>>
  try {
    posts = await getAllPosts()
  } catch {
    posts = []
  }

  const items = posts
    .map((p) => {
      const link = `${site}/news/${p.slug}`
      return `
    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${new Date(p.date).toUTCString()}</pubDate>${p.excerpt ? `
      <description>${esc(p.excerpt)}</description>` : ""}
    </item>`
    })
    .join("")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Longhorn Sim Racing — News</title>
    <link>${esc(`${site}/news`)}</link>
    <atom:link href="${esc(self)}" rel="self" type="application/rss+xml" />
    <description>Announcements and blog posts from Longhorn Sim Racing.</description>
    <language>en</language>${items}
  </channel>
</rss>
`

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
    },
  })
}
