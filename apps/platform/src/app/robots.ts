import { getSiteUrl } from "@/lib/site-url"

export default function robots() {
  const base = getSiteUrl()
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/auth", "/account", "/check-in", "/api"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  }
}
