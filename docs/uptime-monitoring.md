# Uptime monitoring

Issue [#130](https://github.com/longhorn-sim-racing/lsr-monorepo/issues/130) tracks
measurement of the leadership charter's 99.9% availability target. Better Stack
checks production from outside Vercel and Supabase, so an outage of either can
still trigger an alert. Monitoring starts when the monitors are enabled; it cannot
establish availability for earlier months.

## Deployment and ownership

1. Deploy the `/api/health` route through the normal PR and production deployment.
2. Use an LSR-owned Better Stack account. Give the Tech Team lead and a backup
   access so ownership survives officer turnover. Confirm the plan supports the
   desired alert destinations and reporting before enabling paid features.
3. Configure the two monitors below against the canonical production domain.
   Preview deployments and localhost are not part of the availability target.
4. Configure the Tech Team alert destination and test delivery and recovery.
5. Record the monitor IDs, monitoring start time, account owner, primary responder,
   backup, and alert destination in the team's private operations records. Record
   the date and result of the alert test there too. Never commit tokens or webhook
   URLs to this repository.

The external account, monitors, alert recipients, and reporting must be configured
separately; merging this code does not create them. No new Vercel secrets or database
migrations are required for the health endpoint.

### Initial setup status

Better Stack is configured to send alerts to the admin email address. Local manual
verification passed for the health endpoint with the database available (`200`),
unavailable (`503`), and restored (`200`).

After production deployment, verify the health monitor and test external outage and
recovery notifications. Confirm the backup responder, reporting owner, and first
reporting date before closing #130.

## Monitor configuration

| Setting | Homepage | Application health |
| --- | --- | --- |
| URL | `https://www.longhornsimracing.org/` | `https://www.longhornsimracing.org/api/health` |
| Method | GET | GET |
| Check | Successful HTTP response containing `Longhorn Sim Racing` | Expected HTTP status `200` |
| Healthy response | Rendered homepage | `{"status":"ok"}` |
| Check interval | 180 seconds on the free plan | 180 seconds on the free plan |
| Request timeout | 10 seconds | 10 seconds |
| Confirmation period | 0 seconds; use the provider's location confirmation | Same |
| Recovery period | 0 seconds | Same |
| TLS verification | Enabled | Enabled |
| Scheduled maintenance exclusions | None | None |

Use the homepage keyword monitor and health expected-status-code monitor. Review
the initial successful responses in Better Stack. Monitor the final canonical HTTPS
URLs directly; investigate unexpected redirects. Leave authentication headers empty:
these are public endpoints, and monitoring must not depend on a member session.

The free plan's three-minute checks can miss short outages and only approximate
outage boundaries. A 60-second interval, if supported by the chosen plan, provides
finer measurement. Keep the interval and confirmation settings consistent and record
any changes with the monthly report.

### What health means

`GET /api/health` runs `SELECT 1` through the application's existing Prisma client
and connection pool. It returns:

- `200` and `{"status":"ok"}` after the database responds.
- `503` and `{"status":"unavailable"}` if the database check fails or takes more
  than five seconds.

Both responses use `Cache-Control: no-store`, and Next.js executes the route on
each request. It reads no member data and exposes no connection strings, error
details, or infrastructure metadata. The five-second deadline bounds the response
once the handler starts; it does not cancel the underlying Prisma query. Existing
database connection and pool timeouts still apply. Cold starts can add latency,
which is why the external timeout is longer.

This checks application/database reachability. It does not verify schema migrations,
sign-in, checkout, email delivery, or third-party integrations. The homepage and
health monitor results should therefore be described as measured availability of
these two endpoints, not proof that every site feature works.

## Alerts and response

Configure both monitors to notify the Tech Team's shared email address and, where
supported by the plan, the team's chat channel. Route incidents to a named primary
responder and backup, with escalation to the backup after five minutes without an
acknowledgment. Enable both outage and recovery notifications. Provider alerts must
not depend on the platform's own email service or a webhook hosted on this site.

Before treating alerts as operational:

1. Send a provider test notification and verify the primary, backup, and shared
   destination receive it. Check the configured escalation path too.
2. Use a separate temporary test monitor against a known missing path on the
   production site to exercise an incident; change it to the homepage to verify
   recovery. Do not break production, stop its database, or change the real monitors
   for this test. Remove the temporary monitor afterwards and exclude it from reports.
3. Verify the two real monitors are up and note their first observation time.

When an alert arrives, acknowledge it, check the homepage and health route, then
inspect Vercel deployment/function logs and Supabase status. Roll back a faulty
deployment using the normal deployment process when appropriate. Add the cause,
impact, response, and follow-up to the incident record. Confirm external monitors
have recovered before closing the response.

## Monthly board number

The proposed reporting convention is a calendar month in `America/Chicago`, with
the service unavailable whenever **either** production monitor is down. Confirm
this interpretation with leadership; the target itself remains 99.9%. Include
maintenance downtime. Do not pause monitors for releases or silently exclude
incidents to improve the result.

On the first business day after each month, the Tech Team lead or backup prepares
the previous month's board update from Better Stack's availability/incident data:

1. Select only the two production monitors and the exact Central-time month, from
   midnight on the first day to midnight on the next month's first day. Translate
   both boundaries separately if the provider requires UTC; a DST change can make
   the offsets differ.
2. Use compound availability if the plan supports it, verifying its semantics
   match "either monitor down". Otherwise export the incident intervals, clip each
   to the reporting window, and merge overlapping intervals across both monitors.
   Do not average monitor percentages or add overlapping downtime twice.
3. Compute `availability = 100 × (observed seconds − merged downtime seconds) /
   observed seconds`. Compare the unrounded value with 99.9%; round only for display.
   A 30-day, 720-hour window allows 43 minutes and 12 seconds of downtime.
4. Report coverage separately. Label the first month as partial from the monitoring
   start time. If monitors were paused or history is missing, mark those periods as
   unknown and avoid claiming full-month compliance. Don't treat missing data as uptime.
5. Save the provider report/export with the board materials in the club's existing
   shared records before the plan's history retention expires. Include the observation
   window, settings, and incident links so the number can be checked later.

Suggested board update:

```text
Period: YYYY-MM, America/Chicago
Coverage: full month / partial (start and end) / unknown gaps
Measured availability: ___% (target: 99.9%; met / missed / insufficient coverage)
Downtime: ___ minutes (union of homepage and health incidents)
Outages: ___ distinct merged outage intervals
Largest incident: ___ minutes — cause and follow-up
Evidence: saved report/export and incident links
Prepared by: ___
```

Start with this monthly manual report. Scheduled delivery can be added once the
account's reporting features, recipients, and measurement convention are confirmed.

## Verification

Local development uses the local Supabase stack only. With that stack and the dev
server running, `curl -i http://localhost:3000/api/health` should return `200` with
`Cache-Control: no-store`. With the local database unavailable, it should return
`503` with the same cache header. Restore local Supabase and repeat to check recovery.

After deploying, check `https://www.longhornsimracing.org/api/health` from outside
the app and verify Better Stack sees both monitors as healthy. Keep #130 open until
the monitors, tested Tech Team alerts, reporting owner, and first reporting date
are recorded.

## Provider references

- [Monitoring setup](https://betterstack.com/docs/uptime/monitoring-start/)
- [Check intervals](https://betterstack.com/docs/uptime/check-frequency/)
- [Monitor settings](https://betterstack.com/docs/uptime/api/create-a-new-monitor/)
- [Availability and incident reporting](https://betterstack.com/docs/getting-started/team-and-account-management/reporting/)
