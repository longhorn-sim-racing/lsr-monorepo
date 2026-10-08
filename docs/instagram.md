# Instagram feed

The News page shows the newest posts from [@longhorn_sim_racing](https://instagram.com/longhorn_sim_racing). Posts are copied into the site's database and Cloudinary every hour, so pages never call Instagram and keep working when Instagram is slow or down.

## How it works

1. **Connecting.** An officer pastes an access token into **Admin → Instagram**. The site checks it with Instagram and stores it in `SystemSetting` under `instagram`. The token is never shown again or written to the audit log.
2. **Syncing.** `.github/workflows/instagram-cron.yml` calls `/api/cron/instagram` at seven minutes past every hour (it uses the same `CRON_SECRET` and `SITE_URL` secrets as the notification cron). Each run:
   - fetches the 24 newest posts from the Instagram API with Instagram Login (`src/lib/instagram.ts`);
   - copies each new post's image to Cloudinary as `instagram/<media id>`, because Instagram's own image links expire. Reels use their cover frame and albums their first item;
   - saves or updates the post in `InstagramPost`, including edited captions;
   - removes posts that were deleted on Instagram (only within the 24 it just fetched);
   - renews the token once it's a week old. Tokens last 60 days, and a renewal adds another 60.
3. **Showing.** `/news` shows the 8 newest posts that aren't hidden (`src/app/news/instagram-feed.tsx`). With no news posts yet, the Instagram grid leads the page.

Officers can hide a post from the site in **Admin → Instagram** without touching Instagram. **Check now** runs a sync immediately.

The code is in `src/server/services/instagram.service.ts`.

## Setting it up

1. Vercel needs `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` (the same values `scripts/gallery-import.ts` uses). Without them the sync saves posts but can't copy images, and Admin → Instagram shows a warning.
2. Someone with the club Instagram login follows the Media setup guide: switch the account to a professional account, create a Meta developer app, generate an access token, and paste it into Admin → Instagram. It takes about 30 minutes, once.

Requirements on Instagram's side:

- The account has to be a **Business or Creator** account, and public.
- The Meta app can stay in Development mode. It only reads the club's own account, which has a role on the app, so Meta's App Review isn't needed.

## When something goes wrong

Admin → Instagram shows the last error. The workflow logs only counts and errors, never the token, because the repo's Actions logs are public.

| Message | What to do |
|---|---|
| Instagram access has expired or was revoked | Generate a new token in the Meta dashboard (the app's **API setup with Instagram login** page, **Generate token**) and paste it in Admin → Instagram. This can happen if the sync didn't run for 60 days, after an Instagram password change, or if the app was removed from the account. |
| Couldn't copy N images | Usually missing Cloudinary keys (see above). Images are retried on the next sync. |
| Instagram didn't accept that token | The paste was incomplete, or the token is for a different app or account. Copy it again. |

Some reels with licensed music come through without a video file. That doesn't matter here, since the site only uses the cover frame and links to the post.

## Testing locally

Set `INSTAGRAM_GRAPH_URL` to point the sync at a stand-in server that answers `/me`, `/me/media` and `/refresh_access_token` the way Instagram does. Don't use a real token on a local database that might be shared or reset.
