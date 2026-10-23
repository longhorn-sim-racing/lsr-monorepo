/**
 * What the club's tables mean, written for Jack (#161). describe_schema returns these with the
 * columns; the system prompt may include JACK_SCHEMA_NOTES too. Keep them short, true to the code
 * (the services and queries named in each note are the source of truth), and update them when a
 * definition changes.
 */

export const JACK_SCHEMA_NOTES = `How the club's data fits together:

Time and money
- Every timestamp is stored in UTC without a time zone. The club runs on Central time (America/Chicago). The tools already give times in Central time with the weekday ("Fri 2026-10-09 16:49 CT"), run_sql included for timestamp columns, so select timestamps as stored, as their own columns (a time inside text, JSON or an array stays UTC, and a ::date or ::time of a stored column is its UTC date or time). To group or filter by Central day, week or month, convert inside the expression (col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') and cast a bucket to date; turn Central dates into UTC bounds before filtering. Say "CT" when you give a time, and use the weekday the tool gives.
- Money is integer cents (amountCents, registrationFeeCents). Divide by 100 for dollars.

Members and roles
- "User" is one site account, created the first time someone signs in (createdAt = when they joined; signedUpAt is the same). status: active, pending_verification, retired, deleted. Leave out deleted accounts when counting members.
- Roles: "UserRole" links "User" to "Role" (Role.key). officer and admin give access to the admin console (both count as officers); lsc_driver and collegiate_driver are display badges only. User.officerTitle is the board title shown on the site.
- Membership tiers: "UserMembership" rows (validFrom, validTo) on a "MembershipTier" (key GENERAL, LSR_MEMBER, ALUMNI, PARTNER). Someone with no current membership row is a General member. LSR_MEMBER means paid dues, or an officer granted it; there are no dues this semester. Each LSR membership has a matching lsr_member "Entitlement": sourcePaymentId set = paid through Stripe, null = granted by an officer.
- "Active" for UserMembership and Entitlement: validFrom <= now AND (validTo IS NULL OR validTo >= now). Null validTo = no end.

Events, registrations and attendance
- Event.status is what an officer set: DRAFT (hidden), SCHEDULED (hidden until publishedAt, then public), PUBLISHED, CANCELLED, POSTPONED. What members see is the effective status: a PUBLISHED event, or a SCHEDULED one whose publishedAt has passed, is "in progress" between startsAtUtc and endsAtUtc and "completed" after endsAtUtc. Stored IN_PROGRESS and COMPLETED values are legacy. Public = visibility 'public', not DRAFT, and not a SCHEDULED event still waiting.
- Registrations ("EventRegistration", one per member per event) are sign-ups before the event: REGISTERED has a seat, WAITLISTED is in line (waitlistOrder), NOT_ATTENDING said no or dropped out (not a seat). A removed registration is deleted. Paid events link the seat's Payment (sourcePaymentId).
- Attendance ("EventAttendance") is who actually checked in (method QR or MANUAL), including walk-ins who never registered. If the event takes check-ins (attendanceEnabled, or attendanceReportingMode = 'CHECKIN_REQUIRED'), attendance = check-ins. Otherwise (ASSUME_REGISTERED) everyone REGISTERED counts as having attended.
- "EventSeries" groups events (e.g. a season's races); "Venue" is where an event happens. Event titles name general meetings like "General Meeting 1" or "GM 1".

Lone Star Cup (LSC), the club's league
- "League" (slug lone-star-cup) has "Season" rows (slug like lone-star-cup-s3, with startAt/endAt and a seriesId for its races). The open season is the league's season that hasn't ended yet (endAt >= now), earliest end first.
- The entry form is a "LeagueApplication" (one per driver per season). source: SITE = filled out on the site, ADMIN = an officer backfilled it, GOOGLE_FORM = imported from the old Google Form.
- Entered / "paid for LSC" = an active league_access "Entitlement" for the league with meta->>'seasonSlug' = the season's slug. sourcePaymentId set = paid through Stripe; null = entered by hand by an officer (meta->>'source' = 'manual', comped or paid another way). An entitlement whose validTo has passed is an ended entry (refunded or revoked). A form with no active entitlement = not entered yet.
- The "Entry" table is NOT an LSC entry: it holds each driver's season standings totals (totalPoints, wins, rank), rewritten when an officer clicks "Recompute standings".
- Price: the league's LEAGUE_FEE "Product" (amountCents), or the returning-driver price (Payment.metadata->>'priceTier' = 'returning').

Payments (read only: Jack never moves money; refunds happen in the Stripe dashboard)
- A "Payment" is one checkout: pending when it starts, succeeded when Stripe confirms it (paidAt set), failed when the checkout expired or failed, refunded after a refund in Stripe (amountCents stays the full price, even for a partial refund). Someone who started a checkout and didn't pay has a pending or failed Payment and no active entitlement for it.
- What it was for: "Product".type via productId (ANNUAL_DUES, LEAGUE_FEE, EVENT_FEE). productId null = a paid event registration (EventRegistration.sourcePaymentId points at it).
- metadata->>'duplicateOfEntitlementId' on a succeeded payment = they paid for something they already had; an officer should refund it in Stripe. Donations go through a Stripe link and never appear here.

Race results
- "RawResultUpload" is a results file an officer uploaded for an event (status UPLOADED, PARSED, INGESTED, FAILED). Ingesting it creates "RaceSession" rows (sessionType RACE, QUALIFYING or PRACTICE) with "RaceParticipant", "RaceResult" (position, points, status FINISHED or DSQ; DNF is never recorded), "RaceLap" and "RaceEvent" (collisions). A round has results when its event has a RaceSession; an upload with no sessions isn't processed yet.
- RaceParticipant.userId links a sim driver to a member (through "DriverIdentity".driverGuid); unlinked drivers don't score standings. Lap and race times are milliseconds.

Everything else
- "AuditLog" records admin changes and payment events: actionType (CREATE, UPDATE, DELETE, PAYMENT_SUCCEEDED, LEAGUE_ENTRY_GRANTED, …), entityType and entityId, actorUserId (null = the system, e.g. the Stripe webhook), targetUserId, summary, and before/after JSON.
- "JackRoom" and "JackMessage" are these chat rooms. "SystemSetting" is off-limits (it holds secrets).
- IDs are text UUIDs; foreign keys are named <thing>Id.`

/** One line on tables whose meaning isn't obvious from the name, shown next to their columns */
export const TABLE_NOTES: Record<string, string> = {
  User: "One site account per person. Emails and EIDs are fine to share with officers.",
  UserMembership: "Membership tier history; no current row = General member.",
  Entitlement: "What a payment (or an officer) granted: lsr_member (dues) or league_access (an LSC entry, meta.seasonSlug).",
  LeagueApplication: "LSC entry form, one per driver per season. Not proof of payment.",
  Entry: "Season standings totals per driver. Not an LSC entry.",
  Event: "status is what an officer set; see the notes for the effective status.",
  EventRegistration: "Sign-ups: REGISTERED, WAITLISTED, NOT_ATTENDING.",
  EventAttendance: "Check-ins at the event.",
  Payment: "One checkout attempt: pending, succeeded, failed, refunded. Cents.",
  Product: "Things sold: ANNUAL_DUES, LEAGUE_FEE, EVENT_FEE. Cents.",
  RawResultUpload: "Uploaded results file; ingested ones have RaceSession rows.",
  RaceSession: "One session (RACE, QUALIFYING, PRACTICE) from an ingested upload.",
  AuditLog: "Admin changes and payment events.",
}
