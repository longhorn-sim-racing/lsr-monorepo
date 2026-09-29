import type { MetadataRoute } from "next"
import { prisma } from "@/server/db"
import { getProducts } from "@/lib/shopify/catalog"

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://www.longhornsimracing.org"

  // 1. Static Pages
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1.0 },
    { url: `${base}/about`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/drivers`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/events`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/gallery`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${base}/lone-star-cup`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/news`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/shop`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${base}/sponsors`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ]

  // Dynamic routes — all wrapped in try/catch so sitemap still generates during outages
  let driverRoutes: MetadataRoute.Sitemap = [];
  let eventRoutes: MetadataRoute.Sitemap = [];
  let postRoutes: MetadataRoute.Sitemap = [];
  let seriesRoutes: MetadataRoute.Sitemap = [];
  let productRoutes: MetadataRoute.Sitemap = [];

  try {
    // 2. Dynamic: Drivers (Users)
    const users = await prisma.user.findMany({
      where: { status: { not: "deleted" } },
      select: { handle: true, updatedAt: true },
    })
    driverRoutes = users.map((user) => ({
      url: `${base}/drivers/${user.handle}`,
      lastModified: user.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }))

    // 3. Dynamic: Events
    const events = await prisma.event.findMany({
      where: { visibility: "public" },
      select: { slug: true, updatedAt: true },
    })
    eventRoutes = events.map((event) => ({
      url: `${base}/events/${event.slug}`,
      lastModified: event.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    }))

    // 4. Dynamic: News Posts
    const posts = await prisma.post.findMany({
      where: { publishedAt: { not: null }, visibility: "public" },
      select: { slug: true, updatedAt: true },
    })
    postRoutes = posts.map((post) => ({
      url: `${base}/news/${post.slug}`,
      lastModified: post.updatedAt,
      changeFrequency: "never" as const,
      priority: 0.7,
    }))

    // 5. Dynamic: Event Series
    const series = await prisma.eventSeries.findMany({
      where: { visibility: "public" },
      select: { slug: true, updatedAt: true },
    })
    seriesRoutes = series.map((s) => ({
      url: `${base}/series/${s.slug}`,
      lastModified: s.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }))
  } catch (error) {
    console.error("[Sitemap] Failed to fetch dynamic routes:", error);
  }

  // 6. Dynamic: Shop Products
  const SHOP_ENABLED = process.env.NEXT_PUBLIC_SHOP_ENABLED === "true";

  if (SHOP_ENABLED) {
    try {
      const products = await getProducts();
      productRoutes = products.map((product) => ({
        url: `${base}/shop/products/${product.handle}`,
        lastModified: new Date(product.updatedAt),
        changeFrequency: "weekly" as const,
        priority: 0.8,
      }));
    } catch (error) {
      console.error("Sitemap: Failed to fetch products", error);
    }
  }

  return [
    ...staticRoutes,
    ...driverRoutes,
    ...eventRoutes,
    ...postRoutes,
    ...seriesRoutes,
    ...productRoutes,
  ]
}
