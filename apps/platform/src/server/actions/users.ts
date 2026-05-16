"use server";

import { prisma } from "@/server/db";
import { requireOfficer, requireSystemAdmin } from "@/server/auth/guards";
import { createAuditLog } from "@/server/audit/log";
import { revalidatePath } from "next/cache";
import { revalidateDriverList } from "@/server/cache/revalidate-public";

export type UpdateUserPayload = {
    displayName: string;
    handle: string;
    bio: string | null;
    iRating: number | null;
    gradYear: number | null;
    major: string | null;
    socials: Record<string, string> | null;
    officerTitle: string | null;
    roleKeys: string[];
    activeMembershipTierKey: string | null; // e.g. "LSR_MEMBER"
    activeMembershipValidTo: Date | null;
};

export async function updateUser(userId: string, payload: UpdateUserPayload) {
    const currentUser = await requireOfficer();

    // 1. Fetch target user to check for Officer protection
    const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            roles: { include: { role: true } },
            memberships: { include: { tier: true }, orderBy: { validFrom: 'desc' }, take: 1 },
        },
    });

    if (!targetUser) {
        throw new Error("User not found");
    }

    const isTargetOfficer = targetUser.roles.some((r) => ["admin", "officer"].includes(r.role.key));
    const isTargetAdmin = targetUser.roles.some((r) => r.role.key === "admin");
    const isCurrentSystemAdmin = await prisma.userRole.count({
        where: { userId: currentUser.id, role: { key: "admin" } }
    }).then(c => c > 0);


    // PROTECTION: Only Admins can edit Admins/Officers roles
    // If the target IS an officer/admin, and the current user is NOT an admin, fail.
    if ((isTargetOfficer || isTargetAdmin) && !isCurrentSystemAdmin) {
        // Exception: Officer editing THEMSELVES? (Maybe allow title, but usually not roles)
        // For now, strict: Officers cannot edit other Officers or Admins.
        throw new Error("Only Administrators can modify Officer/Admin accounts.");
    }

    // Also prevent Officer from PROMOTING someone to Officer/Admin
    const isPromotingToOfficer = payload.roleKeys.some(k => ["admin", "officer"].includes(k));
    if (isPromotingToOfficer && !isCurrentSystemAdmin) {
        throw new Error("Only Administrators can promote users to Officer roles.");
    }

    // 2. Validate & Update Basic Info
    const trimmedName = payload.displayName.trim();
    const trimmedHandle = payload.handle.trim().toLowerCase();

    if (!trimmedName) {
        throw new Error("Display name cannot be empty.");
    }
    if (!trimmedHandle || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmedHandle)) {
        throw new Error("Handle must be lowercase alphanumeric with hyphens (e.g. john-doe).");
    }

    // Check handle uniqueness if changed
    if (trimmedHandle !== targetUser.handle) {
        const handleTaken = await prisma.user.findUnique({ where: { handle: trimmedHandle } });
        if (handleTaken) {
            throw new Error(`Handle "@${trimmedHandle}" is already taken.`);
        }
    }

    await prisma.user.update({
        where: { id: userId },
        data: {
            displayName: trimmedName,
            handle: trimmedHandle,
            bio: payload.bio || null,
            iRating: payload.iRating,
            gradYear: payload.gradYear,
            major: payload.major || null,
            socials: payload.socials ?? undefined,
            officerTitle: payload.officerTitle || null,
        },
    });

    // 3. Update Roles
    // We strictly set roles to match payload.roleKeys
    // First, get all role definitions to map keys to IDs
    const allRoles = await prisma.role.findMany();
    const roleIdsToSet = allRoles
        .filter((r) => payload.roleKeys.includes(r.key))
        .map((r) => r.id);

    // Transaction for role swap
    await prisma.$transaction(async (tx) => {
        // Delete existing roles
        await tx.userRole.deleteMany({
            where: { userId },
        });
        // Insert new roles
        if (roleIdsToSet.length > 0) {
            await tx.userRole.createMany({
                data: roleIdsToSet.map((roleId) => ({
                    userId,
                    roleId,
                })),
            });
        }
    });

    // 4. Update Membership
    // This logic is simplified: "Active Membership" overrides any existing active ones.
    // We upsert a membership for the chosen tier.
    if (payload.activeMembershipTierKey) {
        const tier = await prisma.membershipTier.findUnique({ where: { key: payload.activeMembershipTierKey } });
        if (tier) {
            // Logic: "Upsert" a valid membership.
            // Since (userId, tierId, validFrom) is unique, it's tricky to pure upsert if validFrom changes.
            // Simplified: Create new if not exists, or update most recent.
            // OR: Just create a new one valid from NOW to payload.validTo.

            // Better approach for this MVP:
            // Find if they have an active membership of this tier.
            // If so, update validTo.
            // If not, create new.

            const now = new Date();
            const existing = await prisma.userMembership.findFirst({
                where: {
                    userId,
                    tierId: tier.id,
                    validFrom: { lte: now },
                    OR: [
                        { validTo: null },
                        { validTo: { gte: now } }
                    ]
                },
                orderBy: { validFrom: 'desc' }
            });

            if (existing) {
                await prisma.userMembership.update({
                    where: { id: existing.id },
                    data: { validTo: payload.activeMembershipValidTo }
                });
            } else {
                await prisma.userMembership.create({
                    data: {
                        userId,
                        tierId: tier.id,
                        validFrom: now,
                        validTo: payload.activeMembershipValidTo
                    }
                });
            }
        }
    }

    // 5. Audit Log
    const beforeRoles = targetUser.roles.map(r => r.role.key).sort();
    const afterRoles = [...payload.roleKeys].sort();
    const beforeMembership = targetUser.memberships[0]
        ? { tier: targetUser.memberships[0].tier.key, validTo: targetUser.memberships[0].validTo }
        : null;
    const afterMembership = payload.activeMembershipTierKey
        ? { tier: payload.activeMembershipTierKey, validTo: payload.activeMembershipValidTo }
        : null;

    await createAuditLog({
        actorUserId: currentUser.id,
        actionType: "UPDATE",
        entityType: "USER",
        entityId: userId,
        targetUserId: userId,
        summary: `Updated user ${targetUser.displayName} (@${targetUser.handle})`,
        before: {
            displayName: targetUser.displayName,
            handle: targetUser.handle,
            bio: targetUser.bio,
            iRating: targetUser.iRating,
            gradYear: targetUser.gradYear,
            major: targetUser.major,
            socials: targetUser.socials,
            officerTitle: targetUser.officerTitle,
            roles: beforeRoles,
            membership: beforeMembership,
        },
        after: {
            displayName: trimmedName,
            handle: trimmedHandle,
            bio: payload.bio,
            iRating: payload.iRating,
            gradYear: payload.gradYear,
            major: payload.major,
            socials: payload.socials,
            officerTitle: payload.officerTitle,
            roles: afterRoles,
            membership: afterMembership,
        },
    });

    revalidatePath(`/admin/users/${userId}/edit`);
    revalidatePath(`/admin/users`);
    revalidatePath(`/drivers/${trimmedHandle}`);
    if (trimmedHandle !== targetUser.handle) {
        revalidatePath(`/drivers/${targetUser.handle}`);
    }
    revalidateDriverList();
}
