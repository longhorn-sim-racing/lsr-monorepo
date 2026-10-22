import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Jack renders slides in headless Chromium (src/server/jack/decks/renderer.ts). The Chromium build
  // finds its binary next to its own files, so neither package can be bundled, and the binary has to
  // be traced into the functions that render: the room page (Jack's reply loop runs there) and the
  // deck image and export routes.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/admin/jack/**": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/admin/jack/**": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com" },
      { protocol: "https", hostname: "www.longhornsimracing.org" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "cdn.shopify.com" },
    ],
  },
  async redirects() {
    return [
      { source: "/series/:slug", destination: "/lone-star-cup", permanent: true },
    ];
  },
}

export default nextConfig;
