// Race results from an Assetto Corsa results file: upload, parse, link to an event, ingest. Used by the
// admin results actions (src/app/admin/results/actions.ts) and by Jack's results.import proposals.
//
// - Callers check permissions first (the admin actions keep requireOfficer()); services take plain
//   values and an actor and return result objects. Unexpected failures (a database error) still throw.
// - Services don't refresh pages: revalidatePath only works inside a request. Each successful result
//   lists the paths it touched in `revalidate`; the caller passes them to revalidatePaths()
//   (src/server/cache/revalidate-public.ts), so the admin page and a proposal refresh the same pages.
// - parseUpload({ write: false }) and previewResultFile() write nothing, so a proposal can show what a
//   file holds (and which drivers aren't linked to members) before an officer applies it. They refuse a
//   file they can't read instead of throwing.
// - scripts/check-results-service.ts replays real uploads through parse, bind and ingest and diffs the
//   race rows against the ones already in the database; run it after changing anything here.

import type { Prisma, RawResultUploadStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { resultsIngestionPaths } from "@/server/cache/revalidate-public";
import { withActorMetadata, type ServiceActor } from "@/server/services/actor";
import type { AcResultFile } from "@/lib/results/ac-result-file";

export const ALREADY_INGESTED = "These results are already ingested. Delete them with their race records to parse the file again.";
const LINK_CHANGED = "Someone changed this upload's event link while it was ingesting. Reload the page and try again.";
const UPLOAD_GONE = "That upload no longer exists. Go back to the results list.";
const NOT_A_RESULTS_FILE = "This file isn't a results file: it has no session data.";

const ADMIN_RESULTS = "/admin/results";
const uploadPath = (uploadId: string) => `/admin/results/${uploadId}`;

/** Thrown inside a transaction to roll it back and report `message` to the officer */
class IngestStopped extends Error {}

/** Ingested means race sessions exist, whatever the status says (older uploads could be re-parsed after ingesting). */
async function hasRaceSessions(uploadId: string) {
  return (await prisma.raceSession.count({ where: { uploadId } })) > 0;
}

export type CreateUploadResult =
  | { ok: true; upload: { id: string; status: RawResultUploadStatus }; revalidate: string[] }
  | { ok: false; error: string };

/** Stores a results file as an upload (status UPLOADED). Only JSON is checked here; parseUpload reads it. */
export async function createUpload(input: { filename: string; bytes: ArrayBuffer }, actor: ServiceActor): Promise<CreateUploadResult> {
  const { filename, bytes } = input;
  const fileText = new TextDecoder().decode(bytes);
  let rawJson;
  try {
    rawJson = JSON.parse(fileText);
  } catch {
    return { ok: false, error: `${filename} isn't valid JSON. Upload the results .json file the server saved.` };
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sha256 = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  const upload = await prisma.rawResultUpload.create({
    data: {
      filename,
      filesize: bytes.byteLength,
      sha256,
      rawJson,
      uploadedByUserId: actor.userId,
    },
    // Only what callers need: the row holds the whole file
    select: { id: true, status: true },
  });

  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "CREATE",
    entityType: "RESULT_UPLOAD",
    entityId: upload.id,
    summary: `Uploaded result file: ${filename}`,
    metadata: withActorMetadata(actor, { filesize: bytes.byteLength, sha256 }),
  });

  return { ok: true, upload, revalidate: [ADMIN_RESULTS] };
}

/** One driver in a results file, as the parse report stores it (ParseReport.drivers) */
export type ResultFileDriver = { guid: string; driverName: string; carModel: string };

/** What parsing finds in a file: the ParseReport row's fields */
export type ResultFileReport = { drivers: ResultFileDriver[]; resultsCount: number; lapsCount: number; anomalies: string[] };

export type ParsedResultFile =
  | {
      ok: true;
      report: ResultFileReport;
      /** PARSED, or FAILED when the file has anomalies (the upload's status after a writing parse) */
      status: "PARSED" | "FAILED";
    }
  | { ok: false; error: string };

/** Reads a results file's drivers and counts, and what's wrong with it. Touches nothing. */
export function parseResultFile(rawJson: unknown): ParsedResultFile {
  if (typeof rawJson !== "object" || rawJson === null) return { ok: false, error: NOT_A_RESULTS_FILE };

  const { Result: results, Laps: laps } = rawJson as AcResultFile;

  const anomalies: string[] = [];
  if (!Array.isArray(results)) {
    anomalies.push("Missing or invalid 'Result' array");
  }
  if (!Array.isArray(laps)) {
    anomalies.push("Missing or invalid 'Laps' array");
  }

  const drivers = new Map<string, { driverName: string; carModel: string }>();
  if (Array.isArray(results)) {
    for (const result of results) {
      if (result.DriverGuid && !drivers.has(result.DriverGuid)) {
        drivers.set(result.DriverGuid, {
          driverName: result.DriverName,
          carModel: result.CarModel,
        });
      } else if (!result.DriverGuid) {
        anomalies.push("Missing driver GUID in result entry");
      }
    }
  }

  const report: ResultFileReport = {
    drivers: Array.from(drivers.entries()).map(([guid, data]) => ({
      guid,
      ...data,
    })),
    resultsCount: results?.length ?? 0,
    lapsCount: laps?.length ?? 0,
    anomalies,
  };
  return { ok: true, report, status: anomalies.length > 0 ? "FAILED" : "PARSED" };
}

/**
 * parseResultFile for the read-only paths, which may see a file nobody has checked yet: one it can't read
 * (a Result entry that's null) is refused instead of throwing. The writing parse still throws on it, as
 * the admin page always has.
 */
function parseResultFileSafely(rawJson: unknown): ParsedResultFile {
  try {
    return parseResultFile(rawJson);
  } catch {
    return { ok: false, error: NOT_A_RESULTS_FILE };
  }
}

/** The drivers not linked to a member (no DriverIdentity, or one without a user): their points won't count in standings */
async function unmatchedDrivers(drivers: ResultFileDriver[]): Promise<ResultFileDriver[]> {
  if (drivers.length === 0) return [];
  const linked = await prisma.driverIdentity.findMany({
    where: { driverGuid: { in: drivers.map((driver) => driver.guid) }, userId: { not: null } },
    select: { driverGuid: true },
  });
  const linkedGuids = new Set(linked.map((identity) => identity.driverGuid));
  return drivers.filter((driver) => !linkedGuids.has(driver.guid));
}

export type ResultFilePreview =
  | { ok: true; report: ResultFileReport; status: "PARSED" | "FAILED"; unmatchedDrivers: ResultFileDriver[] }
  | { ok: false; error: string };

/** A file that isn't uploaded yet (a room file Jack proposes to import): what parsing would find. Only reads, and never throws on a bad file. */
export async function previewResultFile(rawJson: unknown): Promise<ResultFilePreview> {
  const parsed = parseResultFileSafely(rawJson);
  if (!parsed.ok) return parsed;
  return { ...parsed, unmatchedDrivers: await unmatchedDrivers(parsed.report.drivers) };
}

/** `write: false` only reads. `write: true` saves the parse (DriverIdentity, ParseReport, status) as the actor. */
export type ParseUploadOptions = { write: false } | { write: true; actor: ServiceActor };

export type ParseUploadResult =
  | {
      ok: true;
      upload: {
        id: string;
        /** The upload's status after parsing: PARSED, or FAILED when the file has anomalies. Saved only with `write: true`. */
        status: RawResultUploadStatus;
      };
      report: ResultFileReport;
      unmatchedDrivers: ResultFileDriver[];
      /** Empty for `write: false` */
      revalidate: string[];
    }
  | { ok: false; error: string };

/**
 * Parses an upload: its drivers, counts and anomalies. The same checks run either way (a missing upload,
 * one already ingested, a file that isn't a results file), so `write: false` says exactly what
 * `write: true` would do without doing it. The one difference: a file it can't read at all (a null
 * Result entry) is refused by `write: false` and throws with `write: true`, as the admin page always has.
 *
 * `write: true` is the admin page's Parse step: it records each driver's GUID and name (DriverIdentity),
 * saves the ParseReport and sets the status (FAILED with the anomalies, or PARSED). A file that isn't a
 * results file marks the upload FAILED.
 */
export async function parseUpload(uploadId: string, options: ParseUploadOptions): Promise<ParseUploadResult> {
  const upload = await prisma.rawResultUpload.findUnique({
    where: { id: uploadId },
  });

  if (!upload) {
    return { ok: false, error: UPLOAD_GONE };
  }
  // Re-parsing would reset the status and allow a second ingest of the same race
  if (upload.status === "INGESTED" || (await hasRaceSessions(uploadId))) {
    return { ok: false, error: ALREADY_INGESTED };
  }

  const parsed = options.write ? parseResultFile(upload.rawJson) : parseResultFileSafely(upload.rawJson);
  if (!parsed.ok) {
    if (options.write) {
      await prisma.rawResultUpload.update({
        where: { id: uploadId },
        data: { status: "FAILED", errorMessage: "Invalid JSON structure" },
      });
    }
    return parsed;
  }
  const { report } = parsed;

  if (!options.write) {
    return {
      ok: true,
      upload: { id: upload.id, status: parsed.status },
      report,
      unmatchedDrivers: await unmatchedDrivers(report.drivers),
      revalidate: [],
    };
  }

  // Record each driver's GUID with the name they last raced under
  for (const driver of report.drivers) {
    await prisma.driverIdentity.upsert({
      where: { driverGuid: driver.guid },
      create: {
        driverGuid: driver.guid,
        lastSeenName: driver.driverName,
      },
      update: {
        lastSeenName: driver.driverName,
      },
    });
  }

  await prisma.parseReport.upsert({
    where: { uploadId },
    create: {
      uploadId,
      ...report,
    },
    update: {
      ...report,
    },
  });

  const { anomalies } = report;
  const updatedUpload = await prisma.rawResultUpload.update({
    where: { id: uploadId },
    data: {
      status: anomalies.length > 0 ? "FAILED" : "PARSED",
      errorMessage: anomalies.length > 0 ? anomalies.join(", ") : null,
    },
    select: { id: true, status: true, filename: true },
  });

  await createAuditLog({
    actorUserId: options.actor.userId,
    actionType: "UPDATE",
    entityType: "RESULT_UPLOAD",
    entityId: uploadId,
    summary: `Parsed result upload: ${updatedUpload.filename}`,
    metadata: withActorMetadata(options.actor, { status: updatedUpload.status, anomalies }),
  });

  return {
    ok: true,
    upload: { id: updatedUpload.id, status: updatedUpload.status },
    report,
    unmatchedDrivers: await unmatchedDrivers(report.drivers),
    revalidate: [uploadPath(uploadId), ADMIN_RESULTS],
  };
}

export type BindUploadResult =
  | {
      ok: true;
      upload: { id: string; eventId: string; pointsSystem: string | null; sessionLabel: string | null };
      revalidate: string[];
    }
  | { ok: false; error: string };

/**
 * Links an upload to an event, with its points system and session label (PRACTICE, QUALIFYING, RACE).
 * Practice and qualifying never award points, whatever `pointsSystem` says. An ingested upload's link
 * can't change.
 */
export async function bindUpload(
  input: { uploadId: string; eventId: string; pointsSystem?: string | null; sessionLabel?: string | null },
  actor: ServiceActor,
): Promise<BindUploadResult> {
  const { uploadId, eventId } = input;
  const pointsSystem = input.pointsSystem ?? null;
  const sessionLabel = input.sessionLabel ?? null;

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return { ok: false, error: "That event no longer exists. Refresh and pick another." };
  // Practice and qualifying sessions never award points
  const effectivePoints = sessionLabel === "PRACTICE" || sessionLabel === "QUALIFYING" ? "NONE" : pointsSystem;

  // Locked like ingest, so the link can't change under an ingest that's running. Once ingested, the race
  // records belong to the linked event, so it can't change at all.
  const linked = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RawResultUpload" WHERE id = ${uploadId} FOR UPDATE`;
    if ((await tx.raceSession.count({ where: { uploadId } })) > 0) return false;
    await tx.rawResultUpload.update({
      where: { id: uploadId },
      data: { eventId, pointsSystem: effectivePoints, sessionLabel },
    });
    return true;
  });
  if (!linked) return { ok: false, error: "These results are already ingested, so the event can't change." };

  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "UPDATE",
    entityType: "RESULT_UPLOAD",
    entityId: uploadId,
    summary: `Bound upload to event ${event.title}`,
    metadata: withActorMetadata(actor, { eventId, pointsSystem: effectivePoints, sessionLabel }),
  });

  return {
    ok: true,
    upload: { id: uploadId, eventId, pointsSystem: effectivePoints, sessionLabel },
    revalidate: [uploadPath(uploadId)],
  };
}

/** Points for a finishing position. F1: 25-18-15-12-10-8-6-4-2-1. HALF: half of 26-18-15-…; anything else scores 0. */
export function calculatePoints(position: number, system: string | null): number {
  if (system === "F1") {
    const pointsMap: Record<number, number> = {
      1: 25, 2: 18, 3: 15, 4: 12, 5: 10,
      6: 8, 7: 6, 8: 4, 9: 2, 10: 1,
    };
    return pointsMap[position] || 0;
  } else if (system === "HALF") {
    const pointsMap: Record<number, number> = {
      1: 26, 2: 18, 3: 15, 4: 12, 5: 10,
      6: 8, 7: 6, 8: 4, 9: 2, 10: 1,
    };
    const points = pointsMap[position] || 0;
    return points / 2;
  }
  return 0;
}

export type IngestUploadResult =
  | {
      ok: true;
      session: { id: string; eventId: string };
      /** Rows created */
      counts: { participants: number; results: number; laps: number; events: number };
      revalidate: string[];
    }
  | { ok: false; error: string };

/**
 * Turns a linked upload into race records: a RaceSession with its participants (matched to members
 * through DriverIdentity, and to cars through CarMapping), results with points, laps and on-track
 * events (collisions). One transaction with the upload row locked, so two ingests at once can't both
 * create sessions. Marks the upload INGESTED. Standings aren't recomputed here (that's the season page).
 */
export async function ingestUpload(uploadId: string, actor: ServiceActor): Promise<IngestUploadResult> {
  const upload = await prisma.rawResultUpload.findUnique({
    where: { id: uploadId },
  });

  if (!upload) return { ok: false, error: UPLOAD_GONE };
  if (!upload.eventId) return { ok: false, error: "Link this upload to an event before ingesting it." };
  if (upload.status === "INGESTED" || (await hasRaceSessions(uploadId))) return { ok: false, error: ALREADY_INGESTED };
  const eventId = upload.eventId;

  const data = upload.rawJson as AcResultFile;
  const pointsSystem = upload.pointsSystem || "F1"; // Default if not set, though we should set it.

  // Basic validation
  if (!data.Result) return { ok: false, error: "This file has no Result list, so there's nothing to ingest." };

  let created;
  try {
    created = await prisma.$transaction(
      async (tx) => {
        // Lock the upload and check again, so two ingests at once can't both create sessions
        await tx.$queryRaw`SELECT id FROM "RawResultUpload" WHERE id = ${uploadId} FOR UPDATE`;
        if ((await tx.raceSession.count({ where: { uploadId } })) > 0) throw new IngestStopped(ALREADY_INGESTED);
        // The event link and points were read before the lock; stop if they changed since
        const current = await tx.rawResultUpload.findUnique({
          where: { id: uploadId },
          select: { eventId: true, pointsSystem: true, sessionLabel: true },
        });
        if (
          !current ||
          current.eventId !== upload.eventId ||
          current.pointsSystem !== upload.pointsSystem ||
          current.sessionLabel !== upload.sessionLabel
        ) {
          throw new IngestStopped(LINK_CHANGED);
        }

        // 1. Create RaceSession
        const sessionType = upload.sessionLabel || "RACE";
        const session = await tx.raceSession.create({
          data: {
            uploadId,
            eventId,
            sessionType,
            trackName: data.TrackName || "UNKNOWN",
            trackConfig: data.TrackConfig,
            startedAt: data.Date ? new Date(data.Date) : new Date(),
            pointsSystem: pointsSystem,
          },
        });

        const isRaceSession = sessionType === "RACE";
        const counts = { participants: 0, results: 0, laps: 0, events: 0 };

        // 2. Process Participants (Cars) & Map Identity
        const carIdToParticipantId = new Map<number, string>();
        const guidToParticipantId = new Map<string, string>();

        const cars = Array.isArray(data.Cars) ? data.Cars : [];
        const driverGuids = cars.map((c) => c.Driver?.Guid).filter(Boolean);

        if (Array.isArray(data.Result)) {
          data.Result.forEach((r) => {
            if (r.DriverGuid) driverGuids.push(r.DriverGuid);
          });
        }

        const uniqueGuids = Array.from(new Set(driverGuids)) as string[];
        const identities = await tx.driverIdentity.findMany({
          where: { driverGuid: { in: uniqueGuids } },
        });
        const identityMap = new Map(identities.map((i) => [i.driverGuid, i.userId]));

        // Car mappings for every car name in the session
        const carNames = new Set<string>();
        cars.forEach((c) => {
          if (c.Model) carNames.add(c.Model);
        });
        const carMappings = await tx.carMapping.findMany({
          where: { gameCarName: { in: Array.from(carNames) } },
        });
        const carMappingMap = new Map(carMappings.map((m) => [m.gameCarName, m.id]));

        const processedGuids = new Set<string>();

        for (const car of cars) {
          const driver = car.Driver;
          const guid = driver?.Guid || `UNKNOWN_GUID_${car.CarId}`;

          if (processedGuids.has(guid)) {
            const existingId = guidToParticipantId.get(guid);
            if (existingId && car.CarId !== undefined) {
              carIdToParticipantId.set(car.CarId, existingId);
            }
            continue;
          }
          processedGuids.add(guid);

          const userId = identityMap.get(guid);
          const carName = car.Model;
          const carMappingId = carName ? carMappingMap.get(carName) : null;

          const participant = await tx.raceParticipant.create({
            data: {
              sessionId: session.id,
              driverGuid: guid,
              displayName: driver?.Name || "Unknown",
              carName: carName,
              carMappingId: carMappingId, // Link mapping immediately if available
              carClass: driver?.ClassID || "UNKNOWN",
              teamName: driver?.Team,
              userId: userId,
              carIdInSession: car.CarId,
              nation: driver?.Nation,
              skin: car.Skin,
              ballastKg: car.BallastKG,
              restrictor: car.Restrictor,
            },
          });
          counts.participants++;

          if (car.CarId !== undefined) {
            carIdToParticipantId.set(car.CarId, participant.id);
          }
          if (guid) {
            guidToParticipantId.set(guid, participant.id);
          }
        }

        // 3. Process Results. The array order is the finishing order.
        if (Array.isArray(data.Result)) {
          let position = 1;

          for (const res of data.Result) {
            let participantId = res.DriverGuid ? guidToParticipantId.get(res.DriverGuid) : undefined;
            if (!participantId && res.CarId !== undefined) {
              participantId = carIdToParticipantId.get(res.CarId);
            }

            if (!participantId) {
              console.warn(`Result entry for guid ${res.DriverGuid} / carId ${res.CarId} has no matching participant.`);
              continue;
            }

            const currentPos = position++;
            const points = isRaceSession ? calculatePoints(currentPos, pointsSystem) : 0;

            await tx.raceResult.create({
              data: {
                sessionId: session.id,
                participantId: participantId,
                position: currentPos,
                classPosition: 0,
                bestLapTime: res.BestLap,
                totalTime: res.TotalTime,
                lapsCompleted: res.LapCount ?? 0,
                status: res.Disqualified ? "DSQ" : "FINISHED",
                gap: res.Gap,

                points: points,
                penaltyTime: res.PenaltyTime,
                lapPenalty: res.LapPenalty,
                isDisqualified: res.Disqualified || false,
              },
            });
            counts.results++;
          }
        }

        // 4. Process Laps
        if (Array.isArray(data.Laps)) {
          const lapsToCreate: Prisma.RaceLapCreateManyInput[] = [];
          const driverLapCounts = new Map<string, number>();
          const sortedLaps = [...data.Laps].sort((a, b) => (a.Timestamp || 0) - (b.Timestamp || 0));

          for (const lap of sortedLaps) {
            let participantId = lap.DriverGuid ? guidToParticipantId.get(lap.DriverGuid) : undefined;
            if (!participantId && lap.CarId !== undefined) {
              participantId = carIdToParticipantId.get(lap.CarId);
            }
            if (!participantId) continue;

            const currentCount = driverLapCounts.get(participantId) || 0;
            const lapNumber = currentCount + 1;
            driverLapCounts.set(participantId, lapNumber);

            const s1 = lap.Sectors?.[0] ?? null;
            const s2 = lap.Sectors?.[1] ?? null;
            const s3 = lap.Sectors?.[2] ?? null;

            lapsToCreate.push({
              sessionId: session.id,
              participantId,
              lapNumber,
              lapTime: lap.LapTime,
              sector1: s1,
              sector2: s2,
              sector3: s3,
              valid: lap.Cuts === 0,
              cuts: lap.Cuts,
              tyre: lap.Tyre,
              timestamp: lap.Timestamp,
            });
          }

          if (lapsToCreate.length > 0) {
            await tx.raceLap.createMany({
              data: lapsToCreate,
            });
          }
          counts.laps = lapsToCreate.length;

          // Backfill lapsCompleted and totalCuts on each result
          const driverCuts = new Map<string, number>();
          for (const lap of lapsToCreate) {
            const currentCuts = driverCuts.get(lap.participantId) || 0;
            driverCuts.set(lap.participantId, currentCuts + (lap.cuts || 0));
          }

          for (const [pid, count] of driverLapCounts) {
            await tx.raceResult.updateMany({
              where: { sessionId: session.id, participantId: pid },
              data: {
                lapsCompleted: count,
                totalCuts: driverCuts.get(pid) || 0,
              },
            });
          }
        }

        // 5. Process Events & Count Collisions
        if (Array.isArray(data.Events)) {
          const eventsToCreate: Prisma.RaceEventCreateManyInput[] = [];
          const collisionCounts = new Map<string, number>();

          for (const evt of data.Events) {
            let participantId = null;
            if (evt.CarId !== undefined) participantId = carIdToParticipantId.get(evt.CarId);
            if (!participantId && evt.Driver?.Guid) participantId = guidToParticipantId.get(evt.Driver.Guid);

            // Increment collision count for primary participant
            if (participantId && (evt.Type === "COLLISION_WITH_CAR" || evt.Type === "COLLISION_WITH_ENV")) {
              const count = collisionCounts.get(participantId) || 0;
              collisionCounts.set(participantId, count + 1);
            }

            let otherParticipantId = null;
            if (evt.OtherCarId !== undefined && evt.OtherCarId !== -1) {
              otherParticipantId = carIdToParticipantId.get(evt.OtherCarId);
            }
            if (!otherParticipantId && evt.OtherDriver?.Guid) {
              otherParticipantId = guidToParticipantId.get(evt.OtherDriver.Guid);
            }

            // Increment collision count for other participant (only if with car)
            if (otherParticipantId && evt.Type === "COLLISION_WITH_CAR") {
              const count = collisionCounts.get(otherParticipantId) || 0;
              collisionCounts.set(otherParticipantId, count + 1);
            }

            eventsToCreate.push({
              sessionId: session.id,
              type: evt.Type,
              carId: evt.CarId,
              driverGuid: evt.Driver?.Guid,
              participantId: participantId,
              otherCarId: evt.OtherCarId,
              otherDriverGuid: evt.OtherDriver?.Guid,
              otherParticipantId: otherParticipantId,
              impactSpeed: evt.ImpactSpeed,
              worldPosX: evt.WorldPosition?.X,
              worldPosY: evt.WorldPosition?.Y,
              worldPosZ: evt.WorldPosition?.Z,
              relPosX: evt.RelPosition?.X,
              relPosY: evt.RelPosition?.Y,
              relPosZ: evt.RelPosition?.Z,
            });
          }

          if (eventsToCreate.length > 0) {
            await tx.raceEvent.createMany({
              data: eventsToCreate,
            });
          }
          counts.events = eventsToCreate.length;

          // Backfill collisionCount on each result
          for (const [pid, count] of collisionCounts) {
            await tx.raceResult.updateMany({
              where: { sessionId: session.id, participantId: pid },
              data: { collisionCount: count },
            });
          }
        }

        // 6. Update Upload Status
        await tx.rawResultUpload.update({
          where: { id: uploadId },
          data: { status: "INGESTED" },
        });

        await createAuditLog(
          {
            actorUserId: actor.userId,
            actionType: "INGEST",
            entityType: "RESULT_UPLOAD",
            entityId: uploadId,
            summary: `Ingested result upload ${uploadId} into event ${eventId}`,
            metadata: withActorMetadata(actor, { eventId, pointsSystem }),
          },
          tx,
        );

        return { sessionId: session.id, counts };
      },
      {
        maxWait: 20000,
        timeout: 20000,
      },
    );
  } catch (error) {
    if (error instanceof IngestStopped) return { ok: false, error: error.message };
    throw error;
  }

  // The event's slug, to refresh the right public pages
  const eventMeta = await prisma.event.findUnique({
    where: { id: eventId },
    select: { slug: true },
  });

  return {
    ok: true,
    session: { id: created.sessionId, eventId },
    counts: created.counts,
    revalidate: [uploadPath(uploadId), ...resultsIngestionPaths({ eventSlug: eventMeta?.slug })],
  };
}
