import { after } from "next/server";

/**
 * Runs `task` after the response is sent, through Next's `after()`, so Vercel keeps
 * the function alive until it finishes. A bare un-awaited promise can be frozen with
 * the function once the response goes out (that left notifications PENDING, #52).
 * Outside a request scope (tsx scripts calling services directly) `after()` throws, so
 * the task runs right away instead and the returned promise settles when it's done:
 * await it where you can. Inside a request the promise resolves immediately. Failures
 * are logged with `errorMessage` and never thrown into the caller.
 */
export function runAfterResponse(
  task: () => Promise<unknown>,
  errorMessage = "[after-response] Task failed:"
): Promise<void> {
  const run = async () => {
    try {
      await task();
    } catch (err) {
      console.error(errorMessage, err);
    }
  };

  try {
    after(run);
    return Promise.resolve();
  } catch {
    return run();
  }
}
