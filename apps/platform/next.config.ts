import type { NextConfig } from "next";

const CHROMIUM_BINARY = ["./node_modules/@sparticuz/chromium/bin/**", "../../node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/bin/**"]
// Room files (G5) and documents (T6): src/server/jack/files/extract.ts imports the worker statically,
// which file tracing follows; listed here too so a later change to a dynamic import can't quietly drop it
const PDF_WORKER = ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"]
// sharp's native binary finds libvips through a link next to it (@img/sharp-libvips-linux-x64), which
// file tracing doesn't follow: without these, sharp fails on Vercel with "libvips-cpp.so…: cannot open
// shared object file". Both the link and pnpm's real path, as for Chromium
const LIBVIPS = [
  "../../node_modules/.pnpm/@img+sharp-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/**",
  "../../node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/**",
]

const nextConfig: NextConfig = {
  // Jack renders slides in headless Chromium (src/server/jack/decks/renderer.ts). The Chromium build
  // finds its binary next to its own files, so neither package can be bundled, and the binary has to
  // be traced into the functions that render: the room page (Jack's reply loop runs there, in the
  // actions it posts to, and proposals applied there), the deck page (Publish to Instagram and Add to
  // gallery render slides a deck hasn't rendered yet), the deck image and export routes, render-check,
  // and the hand-off route that runs scheduled Jack replies. pnpm links the package from node_modules/.pnpm and the code runs
  // from there, so the binary is included at that real path as well as through the link.
  // pdfjs-dist (text from PDFs Jack reads) loads its worker file from next to its own build at runtime;
  // bundled, it can't find it ("Setting up fake worker failed"), so it stays a plain Node package too.
  // That alone doesn't get the worker onto Vercel: file tracing only follows legacy/build/pdf.mjs. The
  // code that reads PDFs must import "pdfjs-dist/legacy/build/pdf.worker.mjs" statically and set
  // globalThis.pdfjsWorker to it (pdfjs checks that before loading the file), or the worker has to be
  // added to outputFileTracingIncludes for the routes that read PDFs.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "pdfjs-dist"],
  // Only those routes: a route the binary reaches grows by about 70 MB, Vercel splits big routes into
  // more functions, and the Hobby plan takes at most 12 functions per deployment (with these on every
  // /admin/jack and /api/admin/jack route, previews failed with "No more than 12 Serverless Functions").
  // Keys match the route path anywhere in it ("/app/admin/jack/[roomId]"), so brackets are escaped.
  // libvips goes where sharp runs (src/server/jack/sharp.ts loads it on first use): photo copies when a
  // room file is registered, and gallery adds and Instagram publishing, applied from the room, the deck
  // page or Proposals, or run by a job.
  outputFileTracingIncludes: {
    "/admin/jack/\\[roomId\\]": [...CHROMIUM_BINARY, ...LIBVIPS],
    "/admin/jack/decks/\\[deckId\\]": [...CHROMIUM_BINARY, ...LIBVIPS],
    "/admin/jack/proposals": LIBVIPS,
    "/api/admin/jack/decks/**": CHROMIUM_BINARY,
    "/api/admin/jack/render-check": CHROMIUM_BINARY,
    "/api/admin/jack/run": [...CHROMIUM_BINARY, ...PDF_WORKER, ...LIBVIPS],
    "/api/admin/jack/files/**": [...PDF_WORKER, ...LIBVIPS],
    "/api/cron/tick": [...PDF_WORKER, ...LIBVIPS],
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
