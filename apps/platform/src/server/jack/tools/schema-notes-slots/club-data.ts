import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the club-data track's tables: recruiting, and race results in detail */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Recruiting (officers' teams; the recruiting_pipeline tool reads all of this with the club's rules)
- A "RecruitingCycle" is a round (slug like fall-2026; opensAt, closesAt; at most one isActive). An "Application" is one person's submission for a round (one per person per round); it has one "ApplicationTrack" per team they applied to (track: technology, community, media, competition, business), and decisions are per team.
- Application.state: only SUBMITTED rows are readable (drafts are hidden). The fullName, email, eid, gradYear and major on it are a snapshot from when they applied.
- ApplicationTrack.status: SUBMITTED (shown as "New"), IN_REVIEW, INTERVIEW, ACCEPTED, REJECTED (shown as "Not moving forward"); decidedAt and decidedById are set by every status but IN_REVIEW. There's no interview table: INTERVIEW is only a status.
- "ApplicationReview" rows are officers' reviews of one team application: score 1 to 5 (optional) and notes; added, never edited. "ApplicationEmail" logs each recruiting email (template RECEIVED, INTERVIEW, ACCEPTED, REJECTED).
- Privacy: for applications from anyone with the officer or admin role, their teams, statuses, reviews, scores and emails are hidden from you (and so are the audit entries about them). Never try to work them out.

Race results in detail
- "RaceParticipant" is one sim driver in one session (driverGuid; userId when linked to a member through "DriverIdentity"); "RaceResult" is their classification, "RaceLap" their laps, "RaceEvent" their collisions.
- RaceResult.position is the order in the results file. classPosition is always 0. status is only FINISHED or DSQ: no DNF is ever written (so "Entry".dnfs is always 0); compare lapsCompleted to spot a driver who stopped early. bestLapTime and totalTime are milliseconds; points are set on RACE sessions only (F1 25/18/15/12/10/8/6/4/2/1, HALF = halved, NONE = 0).
- RaceLap.lapNumber counts each driver's laps in order; valid = no cuts. Laps carry no running position.
- Positions gained = the driver's position in the event's QUALIFYING session minus their RACE position (by driverGuid), as Recompute standings counts it. Incidents = RaceResult.totalCuts + collisionCount.
- A season's rounds are the events in its series (Event.seriesId = Season.seriesId) with startsAtUtc between Season.startAt and endAt; there's no direct link. RaceSession.trackName is the sim's track id (e.g. monza), with trackConfig for the layout.`,
  tableNotes: {
    RecruitingCycle: "A recruiting round. At most one isActive.",
    Application: "One person's submission for a round. Only SUBMITTED rows are visible.",
    ApplicationTrack: "One team an applicant chose, with its status (SUBMITTED = New, REJECTED = Not moving forward).",
    ApplicationReview: "An officer's review of one team application: score 1-5 and notes.",
    ApplicationEmail: "Each recruiting email and whether it was sent.",
    RecruitingTrackConfig: "Per round and team: the interview booking link.",
    RaceParticipant: "One sim driver in one session; userId when linked to a member.",
    RaceResult: "A driver's classification. status FINISHED or DSQ only (never DNF); classPosition always 0. Times in ms.",
    RaceLap: "Each lap: lapNumber per driver, lapTime and sectors in ms, valid = no cuts.",
    RaceEvent: "Collisions: COLLISION_WITH_CAR (otherParticipantId set) or COLLISION_WITH_ENV, with impact speed.",
    DriverIdentity: "Maps a sim driverGuid to a member (userId).",
    CarMapping: "The display name for a sim car name.",
    ParseReport: "What parsing an upload found: drivers, counts and anomalies.",
  },
}
