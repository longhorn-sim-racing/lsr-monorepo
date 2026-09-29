"use client";

import { useState, useMemo } from "react";
import { User, Role, MembershipTier, UserRole, UserMembership } from "@prisma/client";
import { Search, Users, ChevronUp, ChevronDown, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusIcons } from "@/components/status-indicators";
import { getStatusIndicators, getActiveTierKey } from "@/lib/status-indicators";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import Link from "next/link";

type FullUser = User & {
    officerTitle: string | null;
    roles: (UserRole & { role: Role })[];
    memberships: (UserMembership & { tier: MembershipTier })[];
};

type UsersConsoleProps = {
    initialUsers: FullUser[];
    allRoles: Role[];
    allTiers: MembershipTier[];
};

type SortField = "displayName" | "createdAt";
type SortDirection = "asc" | "desc";

export function UsersConsole({ initialUsers, allRoles }: UsersConsoleProps) {
    const [search, setSearch] = useState("");
    const [sortField, setSortField] = useState<SortField>("displayName");
    const [sortDir, setSortDir] = useState<SortDirection>("asc");
    const [roleFilters, setRoleFilters] = useState<string[]>([]);

    const filteredAndSortedUsers = useMemo(() => {
        let result = [...initialUsers];

        if (search) {
            const q = search.toLowerCase();
            result = result.filter(
                (u) =>
                    u.displayName.toLowerCase().includes(q) ||
                    u.handle.toLowerCase().includes(q) ||
                    u.email.toLowerCase().includes(q)
            );
        }

        if (roleFilters.length > 0) {
            result = result.filter((u) =>
                u.roles.some(r => roleFilters.includes(r.role.key))
            );
        }

        result.sort((a, b) => {
            const fieldA = sortField === "displayName" ? a.displayName.toLowerCase() : a.createdAt;
            const fieldB = sortField === "displayName" ? b.displayName.toLowerCase() : b.createdAt;
            if (fieldA === fieldB) return 0;
            const comparison = fieldA > fieldB ? 1 : -1;
            return sortDir === "asc" ? comparison : -comparison;
        });

        return result;
    }, [initialUsers, search, sortField, sortDir, roleFilters]);

    const toggleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDir(sortDir === "asc" ? "desc" : "asc");
        } else {
            setSortField(field);
            setSortDir("asc");
        }
    };

    const toggleRoleFilter = (roleKey: string) => {
        setRoleFilters((prev) =>
            prev.includes(roleKey) ? prev.filter((r) => r !== roleKey) : [...prev, roleKey]
        );
    };

    const SortIndicator = ({ field }: { field: SortField }) => {
        if (sortField !== field) return <ChevronDown size={10} className="ml-1.5 opacity-0" />;
        return sortDir === "asc"
            ? <ChevronUp size={10} className="ml-1.5 text-lsr-orange" />
            : <ChevronDown size={10} className="ml-1.5 text-lsr-orange" />;
    };

    return (
        <div className="flex flex-col h-[calc(100vh-6rem)] border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
            {/* Toolbar */}
            <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger>
                            <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10 cursor-help">
                                <Users size={14} className="text-lsr-orange" />
                                <span className="font-bold text-white/80 tracking-wider uppercase">
                                    User Management
                                </span>
                            </div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
                            <p className="font-bold mb-1 text-lsr-orange">User Console</p>
                            <p className="text-xs text-white/80">
                                Manage user accounts, assign roles, and set membership tiers.
                                Click a row to edit.
                            </p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>

                <div className="h-6 w-px bg-white/10 mx-2" />

                <div className="flex items-center gap-2 relative flex-1 max-w-md">
                    <Search size={14} className="absolute left-3 text-white/40" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search users..."
                        className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
                    />
                </div>

                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleSort("displayName")}
                        className={cn("text-xs uppercase tracking-wider h-8", sortField === "displayName" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
                    >
                        Name <SortIndicator field="displayName" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleSort("createdAt")}
                        className={cn("text-xs uppercase tracking-wider h-8", sortField === "createdAt" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
                    >
                        Joined <SortIndicator field="createdAt" />
                    </Button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    "text-xs uppercase tracking-wider h-8 border border-transparent",
                                    roleFilters.length > 0 ? "text-lsr-orange bg-lsr-orange/10 border-lsr-orange/20" : "text-white/60"
                                )}
                            >
                                <Filter size={10} className="mr-1.5" />
                                Role {roleFilters.length > 0 && `(${roleFilters.length})`}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-black border-white/10 text-white w-48">
                            <DropdownMenuLabel className="text-xs text-white/40 uppercase tracking-widest font-bold">
                                Filter by Role
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator className="bg-white/10" />
                            {allRoles.map((role) => (
                                <DropdownMenuCheckboxItem
                                    key={role.id}
                                    checked={roleFilters.includes(role.key)}
                                    onCheckedChange={() => toggleRoleFilter(role.key)}
                                    className="text-xs font-mono uppercase focus:bg-white/10 focus:text-white"
                                >
                                    {role.key}
                                </DropdownMenuCheckboxItem>
                            ))}
                            {roleFilters.length > 0 && (
                                <>
                                    <DropdownMenuSeparator className="bg-white/10" />
                                    <DropdownMenuItem
                                        onSelect={() => setRoleFilters([])}
                                        className="text-xs text-lsr-orange uppercase tracking-widest font-bold justify-center cursor-pointer focus:bg-lsr-orange/10 focus:text-lsr-orange"
                                    >
                                        Clear Filters
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {/* Column Headers */}
            <div className="bg-white/5 border-b border-white/10 px-5 py-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
                <div className="w-64 shrink-0 text-left">User</div>
                <div className="w-24 shrink-0 text-left">Status</div>
                <div className="w-40 shrink-0 text-left">Membership</div>
                <div className="w-28 shrink-0 text-right">Joined</div>
                <div className="flex-1 text-right">
                    {filteredAndSortedUsers.length} user{filteredAndSortedUsers.length !== 1 ? "s" : ""}
                </div>
            </div>

            {/* List */}
            <TooltipProvider>
                <div className="flex-1 overflow-auto p-2 space-y-1">
                    {filteredAndSortedUsers.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-white/40">
                            No users found matching your search.
                        </div>
                    ) : (
                        filteredAndSortedUsers.map((user) => {
                            const initials = user.displayName
                                .split(" ")
                                .map((n) => n[0])
                                .slice(0, 2)
                                .join("")
                                .toUpperCase();

                            const roleKeys = user.roles.map((r) => r.role.key);
                            const activeTierKey = getActiveTierKey(user.memberships);
                            const activeMembership = user.memberships.find(
                                (m) => !m.validTo || new Date(m.validTo) > new Date()
                            );
                            const isAdmin = roleKeys.includes("admin");
                            const isOfficer = roleKeys.includes("officer");

                            return (
                                <Link
                                    key={user.id}
                                    href={`/admin/users/${user.id}/edit`}
                                    className={cn(
                                        "flex items-center gap-4 px-3 py-2.5 hover:bg-white/5 rounded border border-transparent hover:border-white/10 transition-all group",
                                        (isAdmin || isOfficer) && "bg-white/[0.02]"
                                    )}
                                >
                                    {/* User */}
                                    <div className="w-64 shrink-0 flex items-center gap-3">
                                        <Avatar className="h-8 w-8 rounded border border-white/10 group-hover:border-lsr-orange/50 transition-colors">
                                            <AvatarImage src={user.avatarUrl || undefined} />
                                            <AvatarFallback className="rounded bg-white/5 text-[10px] font-bold text-white/40">
                                                {initials}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0">
                                            <div className="font-bold text-white text-xs truncate group-hover:text-lsr-orange transition-colors">
                                                {user.displayName}
                                            </div>
                                            <div className="text-[10px] text-white/40 truncate">
                                                @{user.handle}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Status Icons */}
                                    <div className="w-24 shrink-0">
                                        <StatusIcons
                                            indicators={getStatusIndicators({
                                                roles: roleKeys,
                                                activeTierKey,
                                                officerTitle: user.officerTitle,
                                            })}
                                        />
                                    </div>

                                    {/* Membership */}
                                    <div className="w-40 shrink-0">
                                        {activeMembership ? (
                                            <div className="flex flex-col">
                                                <span className="text-lsr-orange font-bold text-[10px] uppercase tracking-wider">
                                                    {activeMembership.tier.label}
                                                </span>
                                                {activeMembership.validTo && (
                                                    <span className="text-[9px] text-white/30">
                                                        Expires {format(new Date(activeMembership.validTo), "MMM yyyy")}
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-[10px] text-white/20">Inactive</span>
                                        )}
                                    </div>

                                    {/* Joined */}
                                    <div className="w-28 shrink-0 text-right text-[10px] text-white/40">
                                        {format(new Date(user.createdAt), "yyyy-MM-dd")}
                                    </div>

                                    {/* Chevron */}
                                    <div className="flex-1 flex justify-end">
                                        <span className="text-white/10 group-hover:text-white/40 transition-colors text-xs">
                                            →
                                        </span>
                                    </div>
                                </Link>
                            );
                        })
                    )}
                </div>
            </TooltipProvider>
        </div>
    );
}
