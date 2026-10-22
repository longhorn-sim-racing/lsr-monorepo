import type { NextConfig } from "next";

const CHROMIUM_BINARY = ["./node_modules/@sparticuz/chromium/bin/**", "../../node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/bin/**"]

const nextConfig: NextConfig = {
  // Jack renders slides in headless Chromium (src/server/jack/decks/renderer.ts). The Chromium build
  // finds its binary next to its own files, so neither package can be bundled, and the binary has to
  // be traced into the functions that render: the room page (Jack's reply loop runs there) and the
  // deck image and export routes. pnpm links the package from node_modules/.pnpm and the code runs
  // from there, so the binary is included at that real path as well as through the link.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/admin/jack/**": CHROMIUM_BINARY,
    "/api/admin/jack/**": CHROMIUM_BINARY,
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
