"use server";

import { requireOfficer } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { createAuditLog } from "@/server/audit/log";
import { revalidateAfterResultsIngestion } from "@/server/cache/revalidate-public";
import type { ActionResult } from "@/lib/action-result";
import type { AcResultFile } from "@/lib/results/ac-result-file";
import type { Prisma } from "@prisma/client";

export async function uploadResult(formData: FormData) {
  const user = await requireOfficer();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false as const, error: "Choose a results file to upload." };
  }

  const fileText = await file.text();
  let rawJson;
  try {
    rawJson = JSON.parse(fileText);
  } catch {
    return { ok: false as const, error: `${file.name} isn't valid JSON. Upload the results .json file the server saved.` };
  }

  const fileBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sha256 = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  const newResult = await prisma.rawResultUpload.create({
    data: {
      filename: file.name,
      filesize: file.size,
      sha256,
      rawJson,
      uploadedByUserId: user.id,
    },
    include: {
      uploadedBy: true,
    },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "RESULT_UPLOAD",
    entityId: newResult.id,
    summary: `Uploaded result file: ${file.name}`,
    metadata: { filesize: file.size, sha256 },
  });

  revalidatePath("/admin/results");

  return { ok: true as const, data: newResult };
}

export async function previewParseResult(uploadId: string) {
  const user = await requireOfficer();

  const upload = await prisma.rawResultUpload.findUnique({
    where: { id: uploadId },
  });

  if (!upload) {
    return { ok: false as const, error: "That upload no longer exists. Go back to the results list." };
  }

  const { rawJson } = upload;

  if (typeof rawJson !== "object" || rawJson === null) {
    await prisma.rawResultUpload.update({
      where: { id: uploadId },
      data: { status: "FAILED", errorMessage: "Invalid JSON structure" },
    });
    return { ok: false as const, error: "This file isn't a results file: it has no session data." };
  }

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
      } else {
        if (!result.DriverGuid) {
             anomalies.push("Missing driver GUID in result entry");
        }
      }
    }
  }

  // UPSERT DRIVER IDENTITIES
  for (const [guid, data] of drivers) {
    await prisma.driverIdentity.upsert({
      where: { driverGuid: guid },
      create: {
        driverGuid: guid,
        lastSeenName: data.driverName,
      },
      update: {
        lastSeenName: data.driverName,
      },
    });
  }

  const report = {
    drivers: Array.from(drivers.entries()).map(([guid, data]) => ({
      guid,
      ...data,
    })),
    resultsCount: results?.length ?? 0,
    lapsCount: laps?.length ?? 0,
    anomalies,
  };

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

  const updatedUpload = await prisma.rawResultUpload.update({
    where: { id: uploadId },
    data: {
      status: anomalies.length > 0 ? "FAILED" : "PARSED",
      errorMessage: anomalies.length > 0 ? anomalies.join(", ") : null,
    },
    include: {
      parseReport: true,
      uploadedBy: true,
    },
  });

  await createAuditLog({
      actorUserId: user.id,
      actionType: "UPDATE",
      entityType: "RESULT_UPLOAD",
      entityId: uploadId,
      summary: `Parsed result upload: ${updatedUpload.filename}`,
      metadata: { status: updatedUpload.status, anomalies },
  });

  revalidatePath(`/admin/results/${uploadId}`);
  revalidatePath(`/admin/results`);

  return { ok: true as const, data: updatedUpload };
}

export async function bindEventToUpload(
  uploadId: string,
  eventId: string,
  pointsSystem: string | null = null,
  sessionLabel: string | null = null,
): Promise<ActionResult> {
  const user = await requireOfficer();

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return { ok: false, error: "That event no longer exists. Refresh and pick another." };

  // Practice and qualifying sessions never award points
  const effectivePoints = (sessionLabel === "PRACTICE" || sessionLabel === "QUALIFYING")
    ? "NONE"
    : pointsSystem;

  await prisma.rawResultUpload.update({
    where: { id: uploadId },
    data: { eventId, pointsSystem: effectivePoints, sessionLabel },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "RESULT_UPLOAD",
    entityId: uploadId,
    summary: `Bound upload to event ${event.title}`,
    metadata: { eventId, pointsSystem: effectivePoints, sessionLabel },
  });

  revalidatePath(`/admin/results/${uploadId}`);
  return { ok: true };
}

export async function deleteUpload(uploadId: string, force: boolean = false): Promise<ActionResult> {
  const user = await requireOfficer();

  const upload = await prisma.rawResultUpload.findUnique({
    where: { id: uploadId },
    include: { ingestedSessions: true },
  });

  if (!upload) return { ok: false, error: "That upload was already deleted." };

  if (upload.ingestedSessions.length > 0 && !force) {
    return { ok: false, error: "These results are already ingested. Use the force delete to remove them and their race records." };
  }

  await prisma.rawResultUpload.delete({
    where: { id: uploadId },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "RESULT_UPLOAD",
    entityId: uploadId,
    summary: `Deleted result upload ${upload.filename}`,
  });

  revalidatePath("/admin/results");
  return { ok: true };
}

function calculatePoints(position: number, system: string | null): number {
    if (system === 'F1') {
        const pointsMap: Record<number, number> = {
            1: 25, 2: 18, 3: 15, 4: 12, 5: 10,
            6: 8, 7: 6, 8: 4, 9: 2, 10: 1
        };
        return pointsMap[position] || 0;
    } else if (system === 'HALF') {
        const pointsMap: Record<number, number> = {
            1: 26, 2: 18, 3: 15, 4: 12, 5: 10,
            6: 8, 7: 6, 8: 4, 9: 2, 10: 1
        };
        const points = pointsMap[position] || 0;
        return points / 2;
    }
    return 0;
}

export async function ingestUpload(uploadId: string): Promise<ActionResult> {
  const user = await requireOfficer();

  const upload = await prisma.rawResultUpload.findUnique({
    where: { id: uploadId },
  });

  if (!upload) return { ok: false, error: "That upload no longer exists. Go back to the results list." };
  if (!upload.eventId) return { ok: false, error: "Link this upload to an event before ingesting it." };
  if (upload.status === "INGESTED") return { ok: false, error: "These results are already ingested." };

  const data = upload.rawJson as AcResultFile;
  const pointsSystem = upload.pointsSystem || "F1"; // Default if not set, though we should set it.

  // Basic validation
  if (!data.Result) return { ok: false, error: "This file has no Result list, so there's nothing to ingest." };

  await prisma.$transaction(async (tx) => {
    // 1. Create RaceSession
    const sessionType = upload.sessionLabel || "RACE";
    const session = await tx.raceSession.create({
      data: {
        uploadId,
        eventId: upload.eventId!,
        sessionType,
        trackName: data.TrackName || "UNKNOWN",
        trackConfig: data.TrackConfig,
        startedAt: data.Date ? new Date(data.Date) : new Date(),
        pointsSystem: pointsSystem,
      },
    });

    const isRaceSession = sessionType === "RACE";

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

    // Pre-fetch Car Mappings
    // We need to fetch mappings for all car names in the session
    const carNames = new Set<string>();
    cars.forEach((c) => {
        if (c.Model) carNames.add(c.Model);
    });
    const carMappings = await tx.carMapping.findMany({
        where: { gameCarName: { in: Array.from(carNames) } }
    });
    const carMappingMap = new Map(carMappings.map(m => [m.gameCarName, m.id]));

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
            }
        });

        if (car.CarId !== undefined) {
            carIdToParticipantId.set(car.CarId, participant.id);
        }
        if (guid) {
            guidToParticipantId.set(guid, participant.id);
        }
    }

    // 3. Process Results
    if (Array.isArray(data.Result)) {
        let position = 1;
        
        // Sorting: Ensure results are sorted by position just in case JSON isn't perfect, 
        // though usually the array order IS the position.
        // But we rely on 'position' loop variable, so assuming array is ordered.
        
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
                    
                    points: points, // Calculated Points
                    penaltyTime: res.PenaltyTime,
                    lapPenalty: res.LapPenalty,
                    isDisqualified: res.Disqualified || false,
                }
            });
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
                data: lapsToCreate
            });
        }
        
        // Backfill lapsCompleted and totalCuts in RaceResult if needed
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
                    totalCuts: driverCuts.get(pid) || 0
                }
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
            if (participantId && (evt.Type === 'COLLISION_WITH_CAR' || evt.Type === 'COLLISION_WITH_ENV')) {
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
            if (otherParticipantId && evt.Type === 'COLLISION_WITH_CAR') {
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
                data: eventsToCreate
            });
        }
        
        // Backfill collisionCount in RaceResult
        for (const [pid, count] of collisionCounts) {
             await tx.raceResult.updateMany({
                where: { sessionId: session.id, participantId: pid },
                data: { collisionCount: count }
            });
        }
    }

    // 6. Update Upload Status
    await tx.rawResultUpload.update({
      where: { id: uploadId },
      data: { status: "INGESTED" },
    });

    await createAuditLog({
        actorUserId: user.id,
        actionType: "INGEST",
        entityType: "RESULT_UPLOAD",
        entityId: uploadId,
        summary: `Ingested result upload ${uploadId} into event ${upload.eventId}`,
        metadata: { eventId: upload.eventId, pointsSystem },
    }, tx); // Pass transaction context

  }, {
    maxWait: 20000,
    timeout: 20000,
  });

  // Look up the event slug so we can invalidate the right public pages.
  const eventMeta = await prisma.event.findUnique({
    where: { id: upload.eventId },
    select: { slug: true },
  });

  revalidatePath(`/admin/results/${uploadId}`);
  revalidateAfterResultsIngestion({
    eventSlug: eventMeta?.slug,
  });
  return { ok: true };
}
