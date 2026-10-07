import { prisma } from "@/server/db";
import { CheckinMethod } from "@prisma/client";
import { createAuditLog } from "@/server/audit/log";

/**
 * Core Attendance Service
 * Handles logic for Self Check-in (QR) and Manual Admin Check-in.
 */

export type CheckInResult = {
    alreadyCheckedIn: boolean;
    attendanceId: string;
}

/**
 * Checks in a user to an event.
 * Handles validation of time windows (for self check-in) and idempotency.
 */
export async function checkInUser(
    eventId: string,
    userId: string,
    method: CheckinMethod,
    actorUserId: string
): Promise<CheckInResult> {
    return await prisma.$transaction(async (tx) => {
        // 1. Fetch Event Settings
        // We don't strictly need FOR UPDATE unless we fear config changing mid-request, 
        // but it's safer for strict enforcement.
        const event = await tx.event.findUnique({
            where: { id: eventId },
            select: { 
                attendanceEnabled: true, 
                attendanceOpensAt: true, 
                attendanceClosesAt: true,
                title: true
            }
        });

        if (!event) throw new Error("Event not found");

        const isSelfCheckIn = method === "QR"; // OR other self-methods if added later
        const isAdminOverride = !isSelfCheckIn; // Manual implies admin/officer override logic

        // 2. Validate Rules for Self Check-in
        if (isSelfCheckIn) {
            if (!event.attendanceEnabled) {
                throw new Error("Attendance is not enabled for this event.");
            }

            const now = new Date();
            if (event.attendanceOpensAt && now < event.attendanceOpensAt) {
                throw new Error("Attendance check-in has not opened yet.");
            }
            if (event.attendanceClosesAt && now > event.attendanceClosesAt) {
                throw new Error("Attendance check-in has closed.");
            }
            
            // Validate Actor: Self check-in must be done by the user themselves
            if (userId !== actorUserId) {
                throw new Error("Cannot perform self check-in for another user.");
            }
        }

        // 3. Idempotent Upsert
        // If already checked in, we return the existing record (idempotent success).
        // If not, we create it.
        
        const existing = await tx.eventAttendance.findUnique({
            where: { eventId_userId: { eventId, userId } }
        });

        if (existing) {
            return { alreadyCheckedIn: true, attendanceId: existing.id };
        }

        const newAttendance = await tx.eventAttendance.create({
            data: {
                eventId,
                userId,
                method,
                checkedInByUserId: isAdminOverride ? actorUserId : null,
            }
        });

        // 4. Audit Log (Only for Manual/Admin actions or interesting events)
        if (isAdminOverride) {
            await createAuditLog({
                actorUserId,
                actionType: "CHECKIN",
                entityType: "EVENT_ATTENDANCE",
                entityId: newAttendance.id,
                targetUserId: userId,
                summary: `Manually checked in user ${userId} to event ${eventId}`,
                metadata: {
                    eventId,
                    userId,
                    method,
                    eventTitle: event.title
                }
            }, tx);
        }

        return { alreadyCheckedIn: false, attendanceId: newAttendance.id };
    });
}

/**
 * Removes an attendance record.
 * Only accessible by Admins/Officers (guarded by caller usually, but logic implies force removal).
 */
export async function removeCheckIn(
    eventId: string,
    userId: string,
    actorUserId: string
) {
    return await prisma.$transaction(async (tx) => {
        const existing = await tx.eventAttendance.findUnique({
            where: { eventId_userId: { eventId, userId } },
            include: { event: { select: { title: true } } } // Get title for log
        });

        if (!existing) {
            // Already gone, consider success or throw? Idempotent delete is usually better.
            return;
        }

        await tx.eventAttendance.delete({
            where: { id: existing.id }
        });

        // Audit Log
        await createAuditLog({
            actorUserId,
            actionType: "CHECKIN_REMOVE",
            entityType: "EVENT_ATTENDANCE",
            entityId: existing.id, // ID of the deleted record
            targetUserId: userId,
            summary: `Removed check-in for user ${userId} from event ${eventId}`,
            metadata: {
                eventId,
                userId,
                eventTitle: existing.event.title,
                originalMethod: existing.method,
                checkedInAt: existing.checkedInAt
            },
            before: existing
        }, tx);
    });
}

/**
 * Fetches attendance stats and lists for the admin dashboard.
 */
export async function getEventAttendanceState(eventId: string) {
    const [event, attendances, registrations] = await Promise.all([
        prisma.event.findUnique({ where: { id: eventId } }),
        prisma.eventAttendance.findMany({
            where: { eventId },
            include: { user: true }
        }),
        prisma.eventRegistration.findMany({
            where: { eventId, status: "REGISTERED" },
            include: { user: true }
        })
    ]);

    if (!event) throw new Error("Event not found");

    const attendedUserIds = new Set(attendances.map(a => a.userId));
    
    // Checked In: All records in eventAttendance
    const checkedIn = attendances;

    // Registered but Missing: In registration (REGISTERED) but not in attendance
    const missing = registrations.filter(r => !attendedUserIds.has(r.userId));

    // Walk-ins: In attendance but NOT in registration (or not REGISTERED status)
    // Note: Someone could be WAITLISTED and check in -> they count as Walk-in effectively? 
    // Or just "Checked In"?
    // The requirement says: "Walk-ins (checked-in but not registered)"
    // So we check against the SET of registered user IDs.
    const registeredUserIds = new Set(registrations.map(r => r.userId));
    const walkIns = attendances.filter(a => !registeredUserIds.has(a.userId));

    // Reporting Semantics
    // If attendance is DISABLED or mode is ASSUME_REGISTERED, then everyone registered is "Attended".
    // Otherwise, only those with check-ins are "Attended".
    
    // Note: We use attendanceEnabled as the primary switch for "Tracking Active".
    // If tracking is active, we require check-ins.
    // If tracking is inactive, we assume registration list is the truth.
    
    const isCheckInRequired = event.attendanceEnabled || event.attendanceReportingMode === "CHECKIN_REQUIRED";
    
    // Computed Lists for Reporting
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let attendedUsers: any[] = []; 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let noShows: any[] = [];
    
    if (isCheckInRequired) {
        // Mode: Check-in Required
        attendedUsers = [...attendances]; // The actual check-in records
        noShows = missing; // Registered but not checked in
        // walkIns are already calculated (Checked in but not registered)
    } else {
        // Mode: Assume Registered
        // Attended = All Registered
        attendedUsers = registrations.map(r => ({ ...r, user: r.user, source: 'registration' })); 
        // No shows = 0 (by definition)
        noShows = [];
        // Walk-ins = 0 (technically there are no check-ins if disabled, or we ignore them)
        // But if some exist (e.g. from testing), we separate them? 
        // For reporting "Assume Registered", walk-ins usually don't count if they aren't registered.
    }

    return {
        event,
        stats: {
            totalCheckedIn: checkedIn.length,
            totalRegistered: registrations.length,
            missingCount: missing.length,
            walkInCount: walkIns.length,
            // Computed Reporting Stats
            officialAttendedCount: attendedUsers.length,
            officialNoShowCount: noShows.length
        },
        lists: {
            checkedIn,
            missing,
            walkIns,
            // Computed
            attendedUsers, // This might be used for "Final Results" export
            noShows
        },
        reporting: {
            mode: isCheckInRequired ? "CHECKIN_REQUIRED" : "ASSUME_REGISTERED",
            isCheckInRequired
        }
    };
}

/**
 * Updates attendance configuration for an event.
 * Enforces side-effects like setting reporting mode when enabled.
 */
export async function updateAttendanceConfig(
    eventId: string,
    config: {
        attendanceEnabled: boolean;
        attendanceOpensAt: Date | null;
        attendanceClosesAt: Date | null;
    },
    actorUserId: string
) {
    return await prisma.$transaction(async (tx) => {
        const event = await tx.event.findUnique({ where: { id: eventId } });
        if (!event) throw new Error("Event not found");

        // Logic: If enabling attendance, force reporting mode to CHECKIN_REQUIRED
        // If disabling, we leave it (or could revert, but prompt said "ASSUME_REGISTERED" is default if off, 
        // so the field value technically doesn't matter if enabled=false, but good to keep it clean).
        // Actually, the prompt said: "If attendanceEnabled is ever turned on, set reportingMode to CHECKIN_REQUIRED."
        
        let reportingMode = event.attendanceReportingMode;
        if (config.attendanceEnabled && !event.attendanceEnabled) {
            reportingMode = "CHECKIN_REQUIRED";
        }

        const updatedEvent = await tx.event.update({
            where: { id: eventId },
            data: {
                attendanceEnabled: config.attendanceEnabled,
                attendanceOpensAt: config.attendanceOpensAt,
                attendanceClosesAt: config.attendanceClosesAt,
                attendanceReportingMode: reportingMode
            }
        });

        await createAuditLog({
            actorUserId,
            actionType: "ATTENDANCE_CONFIG_UPDATE",
            entityType: "EVENT",
            entityId: eventId,
            summary: `Updated attendance config for event ${eventId}`,
            metadata: { ...config, reportingMode },
            before: {
                enabled: event.attendanceEnabled,
                opens: event.attendanceOpensAt,
                closes: event.attendanceClosesAt,
                mode: event.attendanceReportingMode
            },
            after: {
                enabled: updatedEvent.attendanceEnabled,
                opens: updatedEvent.attendanceOpensAt,
                closes: updatedEvent.attendanceClosesAt,
                mode: updatedEvent.attendanceReportingMode
            }
        }, tx);

        return updatedEvent;
    });
}
