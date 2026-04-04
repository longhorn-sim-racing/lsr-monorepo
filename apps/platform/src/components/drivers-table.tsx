"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusIcons } from "@/components/status-indicators";
import { getStatusIndicators, getActiveTierKey } from "@/lib/status-indicators";

type DriverRow = {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  status: string;
  officerTitle: string | null;
  roles: { role: { key: string } }[];
  memberships?: { tier: { key: string }; validTo: Date | null }[];
  allTimePoints: number;
  rank: number;
  racingNumber: number | null;
};

type SortConfig = {
  key: string;
  direction: "asc" | "desc";
};

export function DriversTable({ drivers }: { drivers: DriverRow[] }) {
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "rank", direction: "asc" });

  const handleSort = (key: string) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const getValue = (row: DriverRow, key: string) => {
    switch (key) {
      case "rank":
        return row.rank;
      case "number":
        return row.racingNumber ?? Infinity; // so nulls go to the bottom
      case "driver":
        return row.displayName.toLowerCase();
      case "points":
        return row.allTimePoints;
      default:
        return 0;
    }
  };

  const sortedDrivers = [...drivers].sort((a, b) => {
    const aValue = getValue(a, sortConfig.key);
    const bValue = getValue(b, sortConfig.key);

    if (aValue < bValue) return sortConfig.direction === "asc" ? -1 : 1;
    if (aValue > bValue) return sortConfig.direction === "asc" ? 1 : -1;
    return 0;
  });

  const SortHeader = ({
    label,
    sortKey,
    align = "left",
    className,
    tooltip,
  }: {
    label: string;
    sortKey: string;
    align?: "left" | "center" | "right";
    className?: string;
    tooltip?: React.ReactNode;
  }) => (
    <th
      className={cn("px-4 py-4 cursor-pointer select-none group hover:text-white font-sans font-black uppercase tracking-widest text-[9px] text-white/40", className)}
      onClick={() => handleSort(sortKey)}
    >
      <div className={cn("flex items-center gap-1", align === "center" && "justify-center", align === "right" && "justify-end")}>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger className="cursor-help decoration-dashed underline underline-offset-2 flex items-center gap-1">
              {label}
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        ) : (
          label
        )}
        <span className="text-white/30 group-hover:text-white/60 transition-colors">
          {sortConfig.key === sortKey ? (
            sortConfig.direction === "asc" ? (
              <ArrowUp className="w-3 h-3" />
            ) : (
              <ArrowDown className="w-3 h-3" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-100" />
          )}
        </span>
      </div>
    </th>
  );

  return (
    <div className="border border-white/10 bg-lsr-charcoal overflow-hidden">
      <div className="overflow-x-auto">
        <TooltipProvider>
          <table className="w-full text-sm min-w-[500px] md:min-w-full">
            <thead className="bg-white/5 border-b border-white/10">
              <tr>
                <SortHeader label="Pos" sortKey="rank" className="w-12 text-left" />
                <SortHeader label="No." sortKey="number" className="w-16 text-center" align="center" />
                <SortHeader label="Driver" sortKey="driver" className="text-left" />
                <SortHeader
                  label="All Time Pts*"
                  sortKey="points"
                  align="center"
                  className="w-24 md:w-32"
                  tooltip="Total points earned across all races and seasons in a driver's career"
                />
                <th className="px-4 py-4 text-center font-sans font-black uppercase tracking-widest text-[9px] text-white/40 w-24 md:w-32 hidden sm:table-cell">
                  <Tooltip>
                    <TooltipTrigger className="cursor-help decoration-dashed underline underline-offset-2">Events</TooltipTrigger>
                    <TooltipContent>
                      <p>Event attendance tracking coming soon</p>
                    </TooltipContent>
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sortedDrivers.map((d) => {
                const initials = d.displayName
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase();
                const roleKeys = d.roles.map((ur) => ur.role.key);

                return (
                  <tr key={d.id} className="group hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`font-display font-black italic text-xl ${d.rank <= 3 ? "text-lsr-orange" : "text-white/20"
                          }`}
                      >
                        {d.rank}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="font-display font-black italic text-lg text-white/40">
                        {d.racingNumber !== null ? `#${d.racingNumber}` : <span className="text-white/20">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/drivers/${d.handle}`} className="flex items-center gap-4 group/driver">
                        <div className="h-10 w-10 flex-shrink-0 overflow-hidden border border-white/10 bg-black group-hover/driver:border-lsr-orange transition-colors">
                          {d.avatarUrl ? (
                            <Image
                              src={d.avatarUrl}
                              alt=""
                              width={40}
                              height={40}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center font-sans font-bold text-[10px] text-white/30">
                              {initials || "U"}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                            <div className="truncate font-sans font-bold text-white uppercase tracking-tight group-hover/driver:text-lsr-orange transition-colors">
                              {d.displayName}
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              {d.status === "pending_verification" && (
                                <span className="bg-red-900/50 text-red-200 border border-red-900 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest">
                                  Unverified
                                </span>
                              )}
                              <StatusIcons
                                indicators={getStatusIndicators({
                                  roles: roleKeys,
                                  activeTierKey: getActiveTierKey(d.memberships),
                                  officerTitle: d.officerTitle,
                                })}
                              />
                            </div>
                          </div>
                          <div className="text-[9px] font-medium text-white/40 uppercase tracking-widest mt-0.5">
                            @{d.handle}
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-center font-display font-bold text-white text-lg sm:text-xl">
                      {d.allTimePoints > 0 ? (
                        d.allTimePoints
                      ) : (
                        <span className="text-white/20">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      <span className="font-display font-bold italic text-white/20 text-lg tracking-tight">
                        —
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TooltipProvider>
      </div>
    </div>
  );
}
