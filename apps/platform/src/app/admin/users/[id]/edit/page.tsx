import { prisma } from "@/server/db";
import { notFound } from "next/navigation";
import { UserEditForm } from "@/components/admin/user-edit-form";
import { requireOfficer } from "@/server/auth/guards";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { StatusBadges } from "@/components/status-indicators";
import { getStatusIndicators, getActiveTierKey } from "@/lib/status-indicators";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminUserEditPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    await requireOfficer();

    const user = await prisma.user.findUnique({
        where: { id },
        include: {
            roles: { include: { role: true } },
            memberships: { include: { tier: true } },
        },
    });

    if (!user) {
        notFound();
    }

    const [allRoles, allTiers] = await Promise.all([
        prisma.role.findMany(),
        prisma.membershipTier.findMany(),
    ]);

    const initials = user.displayName
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();

    const roleKeys = user.roles.map((r) => r.role.key);
    const activeTierKey = getActiveTierKey(user.memberships);

    return (
        <div className="max-w-3xl mx-auto space-y-8">
            {/* Back link */}
            <Link
                href="/admin/users"
                className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-lsr-orange transition-colors"
            >
                <ArrowLeft className="w-3 h-3" />
                Back to Users
            </Link>

            {/* User header */}
            <div className="border border-white/10 bg-lsr-charcoal p-6 flex items-start gap-5">
                <Avatar className="h-16 w-16 rounded-none border border-white/20 flex-shrink-0">
                    <AvatarImage src={user.avatarUrl ?? undefined} className="rounded-none object-cover" />
                    <AvatarFallback className="rounded-none bg-white/5 text-lg font-black text-white/20">
                        {initials}
                    </AvatarFallback>
                </Avatar>
                <div className="min-w-0 space-y-2">
                    <div>
                        <h1 className="font-display font-black italic text-2xl text-white uppercase tracking-tight">
                            {user.displayName}
                        </h1>
                        <p className="text-xs text-white/40 font-mono">
                            @{user.handle}
                            {user.email && (
                                <span className="ml-3 text-white/25">{user.email}</span>
                            )}
                        </p>
                    </div>
                    <StatusBadges
                        indicators={getStatusIndicators({
                            roles: roleKeys,
                            activeTierKey,
                            officerTitle: user.officerTitle,
                        })}
                    />
                </div>
            </div>

            {/* Edit form */}
            <UserEditForm
                user={user}
                allRoles={allRoles}
                allTiers={allTiers}
            />
        </div>
    );
}
