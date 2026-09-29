"use client";

import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, Maximize2, Minimize2, Search, Info, ChevronUp, ChevronDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RacingNumber, type RacingNumberStyle } from "@/components/racing-number";

type Standing = {
    driver: RacingNumberStyle & {
        id: string;
        name: string;
        handle: string;
        avatarUrl?: string | null;
    };
    points: number;
    wins: number;
    podiums: number;
    starts: number;
    car?: string | null;
    incidents: number;
    bestFinish: number | null;
    rank: number | null;
    positionsGained?: number;
};

type SortConfig = {
    key: string;
    direction: "asc" | "desc";
};

export function StandingsTable({ standings, title = "Standings", infoText }: { standings: Standing[], title?: string, infoText?: string }) {
    const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "rank", direction: "asc" });
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");

    const handleSort = (key: string) => {
        setSortConfig((current) => ({
            key,
            direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
        }));
    };

    const getValue = (row: Standing, key: string) => {
        switch (key) {
            case "rank":
                // Treat null rank as infinity so they go to bottom in asc sort
                return row.rank ?? Infinity;
            case "driver":
                return row.driver.name.toLowerCase();
            case "points":
                return row.points;
            case "wins":
                return row.wins;
            case "podiums":
                return row.podiums;
            case "bestFinish":
                // For race positions, lower is better, but for sorting:
                // If sorting ASC (1 -> 10), we want nulls (no finish) at bottom.
                // If sorting DESC (10 -> 1), we want nulls at bottom too usually?
                // Let's standardise: return value or Infinity if null for correct numeric sort
                return row.bestFinish ?? Infinity;
            case "starts":
                return row.starts;
            case "incidents":
                return row.incidents;
            case "positionsGained":
                return row.positionsGained ?? 0;
            default:
                return 0;
        }
    };

    const sortedStandings = [...standings].sort((a, b) => {
        const aValue = getValue(a, sortConfig.key);
        const bValue = getValue(b, sortConfig.key);

        if (aValue < bValue) return sortConfig.direction === "asc" ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === "asc" ? 1 : -1;
        return 0;
    });

    const filteredStandings = sortedStandings.filter(row => {
        if (!searchTerm) return true;
        return row.driver.name.toLowerCase().includes(searchTerm.toLowerCase());
    });

    const renderPositionChange = (gained: number) => {
        if (gained > 0) return <span className="inline-flex items-center gap-0.5 text-emerald-400 font-bold text-xs"><ChevronUp className="h-3 w-3" />+{gained}</span>;
        if (gained < 0) return <span className="inline-flex items-center gap-0.5 text-red-400 font-bold text-xs"><ChevronDown className="h-3 w-3" />{gained}</span>;
        return <span className="inline-flex items-center gap-0.5 text-white/30 text-xs"><Minus className="h-3 w-3" />0</span>;
    };

    const SortHeader = ({ label, sortKey, align = "left", className }: { label: string; sortKey: string; align?: "left" | "center" | "right"; className?: string }) => (
        <th className={cn("p-4 cursor-pointer select-none group hover:text-white", className)} onClick={() => handleSort(sortKey)}>
            <div className={cn("flex items-center gap-1", align === "center" && "justify-center", align === "right" && "justify-end")}>
                {label}
                <span className="text-white/30 group-hover:text-white/60 transition-colors">
                    {sortConfig.key === sortKey ? (
                        sortConfig.direction === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                    ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-100" />
                    )}
                </span>
            </div>
        </th>
    );

    return (
        <div className={cn(
            "relative flex flex-col transition-all duration-300 bg-black/40",
            isFullscreen ? "fixed inset-0 z-[60] bg-lsr-charcoal" : "border border-white/10"
        )}>
            <div className="flex items-center justify-between p-4 bg-white/5 border-b border-white/10 shrink-0">
                <div className="flex items-center gap-2">
                    <h4 className="font-sans font-bold text-xs text-white/60 uppercase tracking-[0.2em]">{title}</h4>
                    {infoText && (
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger>
                                    <Info className="h-3 w-3 text-white/40 hover:text-lsr-orange transition-colors" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-[300px] bg-lsr-charcoal border border-white/10 text-white/80 text-xs rounded-none">
                                    <p>{infoText}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/40" />
                        <input 
                            type="text" 
                            placeholder="Search Driver..." 
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="bg-black/20 border border-white/10 rounded-none pl-8 pr-2 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-lsr-orange w-32 md:w-48 transition-all"
                        />
                    </div>
                    <button onClick={() => setIsFullscreen(!isFullscreen)} className="p-1.5 text-white/50 hover:text-white transition-colors bg-black/20 hover:bg-black/40 border border-white/10 rounded-none">
                        {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto flex-grow custom-scrollbar">
                <table className="w-full text-left text-sm min-w-[800px]">
                    <thead className="bg-white/5 border-b border-white/10 font-sans font-black text-[10px] uppercase tracking-widest text-white/50 sticky top-0 z-10 backdrop-blur-md">
                        <tr>
                            <SortHeader label="Rank" sortKey="rank" align="center" className="w-12" />
                            <SortHeader label="Driver" sortKey="driver" />
                            <SortHeader label="Points" sortKey="points" align="right" />
                            <SortHeader label="Wins" sortKey="wins" align="center" />
                            <SortHeader label="Podiums" sortKey="podiums" align="center" />
                            <SortHeader label="Best Finish" sortKey="bestFinish" align="center" />
                            <SortHeader label="Starts" sortKey="starts" align="center" />
                            <SortHeader label="+/−" sortKey="positionsGained" align="center" />
                            <SortHeader label="Incidents" sortKey="incidents" align="center" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 font-sans text-white/80">
                        {filteredStandings.map((standing) => (
                            <tr key={standing.driver.id} className="hover:bg-white/5 transition-colors border-b border-white/5">
                                <td className="p-4 font-bold text-center text-white/80">{standing.rank}</td>
                                <td className="p-4">
                                    <Link href={`/drivers/${standing.driver.handle}`} className="flex items-center gap-3 group">
                                        <Avatar className="h-8 w-8 border border-white/10 rounded-none">
                                            <AvatarImage src={standing.driver.avatarUrl || ""} alt={standing.driver.name} className="object-cover" />
                                            <AvatarFallback className="bg-lsr-charcoal text-white/50 text-[10px] font-bold rounded-none">
                                                {standing.driver.name.substring(0, 2).toUpperCase()}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="flex flex-col">
                                            <span className="flex items-baseline gap-2">
                                                <span className="font-bold text-white group-hover:text-lsr-orange transition-colors uppercase tracking-tight">
                                                    {standing.driver.name}
                                                </span>
                                                <RacingNumber user={standing.driver} size="xs" />
                                            </span>
                                            {standing.car && standing.car !== "Unknown" && (
                                                <span className="text-[10px] text-white/40 uppercase font-normal">{standing.car}</span>
                                            )}
                                        </div>
                                    </Link>
                                </td>
                                <td className="p-4 text-right font-mono font-bold text-lsr-orange text-lg">
                                    {standing.points}
                                </td>
                                <td className="p-4 text-center font-mono text-xs text-white/60">
                                    {standing.wins}
                                </td>
                                <td className="p-4 text-center font-mono text-xs text-white/60">
                                    {standing.podiums}
                                </td>
                                <td className="p-4 text-center font-mono text-xs text-white/60">
                                    {standing.bestFinish ? `P${standing.bestFinish}` : "-"}
                                </td>
                                <td className="p-4 text-center font-mono text-xs text-white/60">
                                    {standing.starts}
                                </td>
                                <td className="p-4 text-center">
                                    {standing.positionsGained != null ? renderPositionChange(standing.positionsGained) : "-"}
                                </td>
                                <td className={`p-4 text-center font-mono text-xs ${standing.incidents > 0 ? 'text-red-400' : 'text-white/60'}`}>
                                    {standing.incidents}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}