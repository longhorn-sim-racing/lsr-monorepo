/**
 * sharp, loaded on first use. It's a native module whose shared library (libvips) has to be traced into
 * each Vercel function that runs it (`next.config.ts`); imported statically, a missing library crashed
 * every route that merely linked the module (the Jack pages, his reply route, the tick), not just the
 * image work.
 */
export async function loadSharp() {
  return (await import("sharp")).default
}
