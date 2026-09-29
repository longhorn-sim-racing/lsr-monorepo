"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { type RaceResult, type RaceParticipant, type User, type CarMapping } from "@prisma/client";
import { UserIcon, ArrowUpDown, ArrowUp, ArrowDown, Maximize2, Minimize2, Search, Trophy, Medal, Flag, Timer, Cone, ChevronDown, ChevronUp, Minus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { RacingNumber } from "@/components/racing-number";

type ResultWithParticipant = RaceResult & {
  participant: RaceParticipant & {
    user: User | null;
    carMapping: CarMapping | null;
  };
};

type SortConfig = {
    key: string;
    direction: "asc" | "desc";
};

export function ResultsTable({ results, title, showPoints = true, sessionType = "RACE", positionsGained }: { results: ResultWithParticipant[], title?: string, showPoints?: boolean, sessionType?: string, positionsGained?: Map<string, { gained: number; grid: number }> }) {
  const isPractice = sessionType === "PRACTICE";
  const isQualifying = sessionType === "QUALIFYING";
  const isNonRace = isPractice || isQualifying;
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: isPractice ? "bestLap" : "position", direction: "asc" });
  const [isCollapsed, setIsCollapsed] = useState(isNonRace);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const isRace = sessionType === "RACE";
  const hasPositionsGained = isRace && positionsGained && positionsGained.size > 0;

  const podiumColors: Record<number, string> = { 1: "text-yellow-400", 2: "text-gray-300", 3: "text-amber-600" };
  const podiumBorders: Record<number, string> = { 1: "border-l-yellow-400", 2: "border-l-gray-300", 3: "border-l-amber-600" };

  const renderPositionChange = (gained: number) => {
    if (gained > 0) return <span className="inline-flex items-center gap-0.5 text-emerald-400 font-bold text-xs"><ChevronUp className="h-3 w-3" />+{gained}</span>;
    if (gained < 0) return <span className="inline-flex items-center gap-0.5 text-red-400 font-bold text-xs"><ChevronDown className="h-3 w-3" />{gained}</span>;
    return <span className="inline-flex items-center gap-0.5 text-white/30 text-xs"><Minus className="h-3 w-3" />0</span>;
  };

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    const suffix = s[(v - 20) % 10] || s[v] || s[0];
    return (
      <span className="inline-flex items-center justify-center gap-1">
        {n <= 3 && <Medal className={`h-3.5 w-3.5 ${podiumColors[n]}`} />}
        {n}<span className="font-normal text-white/40 italic text-[0.75em]">{suffix}</span>
      </span>
    );
  };

  const formatTime = (ms: number | null) => {
    if (!ms) return "-";
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milliseconds = ms % 1000;
    return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
  };

  const winnerTime = results.find(r => r.position === 1)?.totalTime ?? 0;
  const winnerLaps = results.find(r => r.position === 1)?.lapsCompleted ?? 0;

  const formatGap = (totalTime: number | null, lapsCompleted: number) => {
      if (!totalTime) return "-";
      if (lapsCompleted < winnerLaps) {
          return `+${winnerLaps - lapsCompleted} Laps`;
      }
      const gap = totalTime - winnerTime;
      return gap === 0 ? "Winner" : `+${(gap / 1000).toFixed(3)}s`;
  }

  const handleSort = (key: string) => {
      setSortConfig((current) => ({
          key,
          direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
      }));
  };

  const getValue = (row: ResultWithParticipant, key: string) => {
      switch (key) {
          case "position": return row.position;
          case "driver": return row.participant.user?.displayName || row.participant.displayName;
          case "car": return row.participant.carMapping?.displayName || row.participant.carName;
          case "laps": return row.lapsCompleted;
          case "totalTime": return row.totalTime ?? Infinity;
          case "gap": return row.gap ?? "";
          case "bestLap": return row.bestLapTime ?? Infinity;
          case "cuts": return row.totalCuts ?? 0;
          case "collisions": return row.collisionCount ?? 0;
          case "points": return row.points ?? 0;
          case "grid": return positionsGained?.get(row.participant.id)?.grid ?? Infinity;
          case "posGained": return positionsGained?.get(row.participant.id)?.gained ?? 0;
          default: return 0;
      }
  };

  const sortedResults = [...results].sort((a, b) => {
      const aValue = getValue(a, sortConfig.key);
      const bValue = getValue(b, sortConfig.key);

      if (aValue < bValue) return sortConfig.direction === "asc" ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
  });

  const filteredResults = sortedResults.filter(row => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      const driverName = (row.participant.user?.displayName || row.participant.displayName).toLowerCase();
      const carName = (row.participant.carMapping?.displayName || row.participant.carName).toLowerCase();
      return driverName.includes(term) || carName.includes(term);
  });

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

  const MobileCard = ({ result }: { result: ResultWithParticipant }) => {
    const user = result.participant.user;
    const mapping = result.participant.carMapping;
    const carDisplay = mapping?.displayName || result.participant.carName;
    const borderClass = !isNonRace && result.position <= 3 ? podiumBorders[result.position] : "border-l-white/10";

    return (
      <div className={cn("border-l-2 bg-white/[0.02] p-3", borderClass)}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {!isPractice && (
              <div className="shrink-0 font-sans font-bold text-sm text-white/80 w-8 text-center">
                {isNonRace ? result.position : ordinal(result.position)}
              </div>
            )}
            {showPoints && result.points !== null && result.points > 0 && (
              <div className="shrink-0 font-sans font-black text-sm text-lsr-orange w-6 text-center">
                {result.points}
              </div>
            )}
            {user ? (
              <Link href={`/drivers/${user.handle}`} className="flex items-center gap-2 min-w-0">
                <Avatar className="h-7 w-7 border border-white/10 rounded-none shrink-0">
                  <AvatarImage src={user.avatarUrl || ""} alt={user.displayName} className="object-cover" />
                  <AvatarFallback className="bg-lsr-charcoal text-white/50 text-[9px] font-bold rounded-none">
                    {user.displayName.substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="font-sans font-bold text-sm text-white truncate">{user.displayName}</span>
                  <RacingNumber user={user} size="xs" className="shrink-0" />
                </span>
              </Link>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 bg-white/5 border border-white/10 flex items-center justify-center rounded-none text-white/20 font-bold text-[9px] shrink-0">?</div>
                <span className="font-sans font-bold text-sm text-white/40 truncate">{result.participant.displayName}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 mt-2 ml-8 flex-wrap">
          <span className="text-[10px] font-bold text-white/30 uppercase tracking-wider">{carDisplay}</span>
          <span className="text-white/10">|</span>
          <span className="font-mono text-[10px] text-lsr-orange font-bold">{formatTime(result.bestLapTime)}</span>
          {!isNonRace && (
            <>
              <span className="text-white/10">|</span>
              <span className="font-mono text-[10px] text-white/40 italic">{formatGap(result.totalTime, result.lapsCompleted)}</span>
            </>
          )}
          {hasPositionsGained && positionsGained?.get(result.participant.id) != null && (
            <>
              <span className="text-white/10">|</span>
              {renderPositionChange(positionsGained.get(result.participant.id)!.gained)}
            </>
          )}
          <span className="text-white/10">|</span>
          <span className="font-mono text-[10px] text-white/40">{result.lapsCompleted} laps</span>
        </div>
      </div>
    );
  };

    return (
        <div className={cn(
            "relative flex flex-col transition-all duration-300 bg-black/40",
            isFullscreen ? "fixed inset-0 z-[60] bg-lsr-charcoal" : "border border-white/10"
        )}>
            <div
                className={cn("flex items-center justify-between p-4 bg-white/5 border-b border-white/10 shrink-0", isNonRace && "cursor-pointer select-none hover:bg-white/[0.08] transition-colors")}
                onClick={isNonRace ? () => setIsCollapsed(prev => !prev) : undefined}
            >
                <div className="flex items-center gap-3">
                    {isPractice ? <Cone className="h-4 w-4 text-white/40" /> : isQualifying ? <Timer className="h-4 w-4 text-blue-400" /> : <Flag className="h-4 w-4 text-lsr-orange" />}
                    <h4 className="font-sans font-bold text-xs text-white/60 uppercase tracking-[0.2em]">{title ?? (isPractice ? "Practice Session" : isQualifying ? "Qualifying Session" : "Race Results")}</h4>
                    {isNonRace && (
                        <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">{results.length} drivers</span>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {isNonRace && (
                        <ChevronDown className={cn("h-4 w-4 text-white/40 transition-transform duration-200", !isCollapsed && "rotate-180")} />
                    )}
                    {!isCollapsed && (
                    <>
                    <div className="relative hidden md:block" onClick={e => e.stopPropagation()}>
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/40" />
                        <input
                            type="text"
                            placeholder="Search Results..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="bg-black/20 border border-white/10 rounded-none pl-8 pr-2 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-lsr-orange w-32 md:w-48 transition-all"
                        />
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setIsFullscreen(!isFullscreen); }} className="hidden md:block p-1.5 text-white/50 hover:text-white transition-colors bg-black/20 hover:bg-black/40 border border-white/10 rounded-none">
                        {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    </>
                    )}
                </div>
            </div>

      <div className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-in-out",
          isCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
      )}>
      <div className="overflow-hidden">

      {/* Desktop table */}
      <div className={cn(
          "hidden md:block overflow-x-auto flex-grow custom-scrollbar",
          !isFullscreen && "max-h-[500px] overflow-y-auto"
      )}>
        <table className="w-full text-left text-sm">
            <thead className="bg-white/5 border-b border-white/10 font-sans font-black text-[10px] uppercase tracking-widest text-white/50 sticky top-0 z-10 backdrop-blur-md">
            <tr>
                {!isPractice && <SortHeader label={isQualifying ? "Qualified" : "Finished"} sortKey="position" align="center" className="w-12" />}
                {showPoints && <SortHeader label="Pts" sortKey="points" align="center" />}
                <SortHeader label="Driver" sortKey="driver" />
                <SortHeader label="Car" sortKey="car" align="center" />
                {isNonRace && <SortHeader label="Best Lap" sortKey="bestLap" align="right" />}
                <SortHeader label="Laps" sortKey="laps" align="center" />
                {!isNonRace && <SortHeader label="Total Time" sortKey="totalTime" align="right" />}
                {!isNonRace && <SortHeader label="Gap" sortKey="gap" align="right" />}
                {!isNonRace && <SortHeader label="Best Lap" sortKey="bestLap" align="right" />}
                {hasPositionsGained && <SortHeader label="Grid" sortKey="grid" align="center" />}
                {hasPositionsGained && <SortHeader label="+/−" sortKey="posGained" align="center" />}
                <SortHeader label="Cuts" sortKey="cuts" align="center" />
                <SortHeader label="Collisions" sortKey="collisions" align="center" />
            </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-sans text-white/80">
            {filteredResults.map((result) => {
                const user = result.participant.user;
                const mapping = result.participant.carMapping;

                return (
                <tr key={result.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    {!isPractice && <td className="p-4 text-center font-sans font-bold text-white/80">{isNonRace ? result.position : ordinal(result.position)}</td>}
                    {showPoints && (
                    <td className="p-4 text-center font-sans font-black text-sm text-lsr-orange">
                        {result.points !== null && result.points > 0 ? result.points : "-"}
                    </td>
                    )}
                    <td className="p-4">
                    <div className="flex items-center gap-3">
                        {user ? (
                        <>
                            <Link href={`/drivers/${user.handle}`} className="group flex items-center gap-3">
                            <Avatar className="h-8 w-8 border border-white/10 rounded-none">
                                <AvatarImage src={user.avatarUrl || ""} alt={user.displayName} className="object-cover" />
                                <AvatarFallback className="bg-lsr-charcoal text-white/50 text-[10px] font-bold rounded-none">
                                {user.displayName.substring(0, 2).toUpperCase()}
                                </AvatarFallback>
                            </Avatar>
                            <span className="flex items-baseline gap-2">
                                <span className="font-sans font-bold text-white group-hover:text-lsr-orange transition-colors">
                                    {user.displayName}
                                </span>
                                <RacingNumber user={user} size="xs" />
                            </span>
                            </Link>
                        </>
                        ) : (
                        <>
                            <div className="h-8 w-8 bg-white/5 border border-white/10 flex items-center justify-center rounded-none text-white/20 font-bold text-[10px]">
                            ?
                            </div>
                            <span className="font-sans font-bold text-white/40">
                            {result.participant.displayName}
                            </span>
                        </>
                        )}
                    </div>
                    </td>
                    <td className="p-4 font-sans text-xs text-center">
                        {mapping ? (
                            <div className="flex flex-col items-center">
                                <span className="text-white/80 font-bold">{mapping.displayName}</span>
                                {mapping.secondaryDisplayName && (
                                    <span className="text-white/40 text-[10px] italic">{mapping.secondaryDisplayName}</span>
                                )}
                            </div>
                        ) : (
                            <span className="text-white/60">{result.participant.carName}</span>
                        )}
                    </td>
                    {isNonRace && <td className="p-4 text-right font-mono text-xs text-lsr-orange">{formatTime(result.bestLapTime)}</td>}
                    <td className="p-4 text-center font-mono text-xs text-white/60">{result.lapsCompleted}</td>
                    {!isNonRace && <td className="p-4 text-right font-mono text-xs text-white/80">{formatTime(result.totalTime)}</td>}
                    {!isNonRace && (
                    <td className="p-4 text-right font-mono text-xs text-white/40 italic">
                        {formatGap(result.totalTime, result.lapsCompleted)}
                    </td>
                    )}
                    {!isNonRace && <td className="p-4 text-right font-mono text-xs text-lsr-orange">{formatTime(result.bestLapTime)}</td>}
                    {hasPositionsGained && (
                    <td className="p-4 text-center font-mono text-xs text-white/50">
                        {positionsGained?.get(result.participant.id)?.grid != null ? `P${positionsGained.get(result.participant.id)!.grid}` : "-"}
                    </td>
                    )}
                    {hasPositionsGained && (
                    <td className="p-4 text-center">
                        {positionsGained?.get(result.participant.id) != null ? renderPositionChange(positionsGained.get(result.participant.id)!.gained) : "-"}
                    </td>
                    )}
                    <td className={`p-4 text-center font-mono text-xs ${result.totalCuts && result.totalCuts > 0 ? 'text-red-400' : 'text-white/40'}`}>
                        {result.totalCuts ?? 0}
                    </td>
                    <td className={`p-4 text-center font-mono text-xs ${result.collisionCount && result.collisionCount > 0 ? 'text-red-400 font-bold' : 'text-white/40'}`}>
                        {result.collisionCount ?? 0}
                    </td>
                </tr>
                );
            })}
            </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden max-h-[500px] overflow-y-auto divide-y divide-white/5">
        {filteredResults.map((result) => (
          <MobileCard key={result.id} result={result} />
        ))}
      </div>

      </div>
      </div>
    </div>
  );
}
