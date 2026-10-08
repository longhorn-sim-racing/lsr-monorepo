// Vercel "Ignored Build Step" (vercel.json ignoreCommand). Exit 0 skips the build, exit 1 builds.
// Skips preview builds for draft PRs; production, branches without a PR, and any lookup
// failure always build. Marking a draft ready doesn't push a commit, so push one (even
// empty) to get its preview.
const { VERCEL_ENV, VERCEL_GIT_PULL_REQUEST_ID, VERCEL_GIT_REPO_OWNER, VERCEL_GIT_REPO_SLUG } = process.env;

async function decide() {
  if (VERCEL_ENV === "production") return { build: true, reason: "production deploy" };
  if (!VERCEL_GIT_PULL_REQUEST_ID) return { build: true, reason: "no pull request for this branch" };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}/pulls/${VERCEL_GIT_PULL_REQUEST_ID}`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "lsr-vercel-ignore-build" },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return { build: true, reason: `GitHub lookup returned ${res.status}` };
    const pr = await res.json();
    return pr.draft
      ? { build: false, reason: `PR #${VERCEL_GIT_PULL_REQUEST_ID} is a draft` }
      : { build: true, reason: `PR #${VERCEL_GIT_PULL_REQUEST_ID} is ready for review` };
  } catch (error) {
    return { build: true, reason: `GitHub lookup failed (${error instanceof Error ? error.message : error})` };
  }
}

const { build, reason } = await decide();
console.log(build ? `Building: ${reason}` : `Skipping build: ${reason}`);
process.exitCode = build ? 1 : 0;
