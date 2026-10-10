"use client";

import { useState, useMemo } from "react";
import { Season, EventSeries } from "@prisma/client";
import { Search, Plus, ArrowUpDown, MoreVertical, Edit, Trash2, RefreshCw, Trophy } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteSeason, recomputeStandings } from "@/app/admin/seasons/actions";
import { cn } from "@/lib/utils";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { toast } from "sonner";

type SeasonWithSeries = Season & {
  series: EventSeries | null;
};

type SeasonsConsoleProps = {
  initialSeasons: SeasonWithSeries[];
};

type SortField = "startAt" | "name" | "year";
type SortDirection = "asc" | "desc";

export function SeasonsConsole({ initialSeasons }: SeasonsConsoleProps) {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("startAt");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const SortIndicator = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={10} className="ml-1.5 opacity-20" />;
    return sortDir === "asc" ? <ChevronUp size={10} className="ml-1.5 text-lsr-orange" /> : <ChevronDown size={10} className="ml-1.5 text-lsr-orange" />;
  };

  // Helper for SortIndicator since I didn't import ChevronUp/Down
  const ChevronUp = ({ size, className }: { size: number, className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m18 15-6-6-6 6"/></svg>
  );
  const ChevronDown = ({ size, className }: { size: number, className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m6 9 6 6 6-6"/></svg>
  );


  const filteredAndSortedSeasons = useMemo(() => {
    let result = [...initialSeasons];

    // Filter
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          (s.series?.title || "").toLowerCase().includes(q)
      );
    }

    // Sort
    result.sort((a, b) => {
      // Dates compare by time (missing ones first); everything else as numbers or text
      const sortKey = (value: string | number | Date | null) =>
        sortField === "startAt" ? (value ? new Date(value).getTime() : 0) : (value ?? "");
      const keyA = sortKey(a[sortField]);
      const keyB = sortKey(b[sortField]);
      if (keyA === keyB) return 0;
      const comparison =
        typeof keyA === "number" && typeof keyB === "number" ? keyA - keyB : String(keyA).localeCompare(String(keyB));
      return sortDir === "asc" ? comparison : -comparison;
    });

    return result;
  }, [initialSeasons, search, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
      if (field === "startAt") setSortDir("desc");
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
      {/* Toolbar */}
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10 cursor-help">
                <Trophy size={14} className="text-lsr-orange" />
                <span className="font-bold text-white/80 tracking-wider uppercase">Seasons</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
              <p className="font-bold mb-1 text-lsr-orange">Seasons Console</p>
              <p className="text-xs text-white/80">
                Manage championship seasons, points tracking, and series associations.
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
            placeholder="Search seasons..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("startAt")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "startAt" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Date <SortIndicator field="startAt" />
            </Button>
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("name")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "name" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Name <SortIndicator field="name" />
            </Button>
             <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("year")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "year" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Year <SortIndicator field="year" />
            </Button>
        </div>

        <div className="flex-1" />

        <Button asChild size="sm" className="bg-lsr-orange hover:bg-lsr-orange/90 text-white border-0 font-bold uppercase tracking-wider text-xs h-8">
          <Link href="/admin/seasons/new">
            <Plus size={14} className="mr-2" /> New Season
          </Link>
        </Button>
      </div>

      {/* Header Labels */}
      <div className="bg-white/5 border-b border-white/10 px-5 py-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
        <div className="flex-1 min-w-[150px]">Name</div>
        <div className="w-40 shrink-0">Slug</div>
        <div className="w-32 shrink-0">Series</div>
        <div className="w-16 shrink-0 text-center">Year</div>
        <div className="w-48 shrink-0">Dates</div>
        <div className="w-32 shrink-0 text-right">Actions</div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {filteredAndSortedSeasons.length === 0 ? (
            <div className="flex items-center justify-center h-full text-white/40">
                No seasons found matching your search.
            </div>
        ) : (
            filteredAndSortedSeasons.map((season) => {
                const start = season.startAt ? new Date(season.startAt) : null;
                const end = season.endAt ? new Date(season.endAt) : null;
                
                return (
                <div
                    key={season.id}
                    className="flex items-center gap-4 p-3 hover:bg-white/5 rounded border border-transparent hover:border-white/10 transition-all group"
                >
                    {/* Name */}
                    <div className="flex-1 min-w-[150px]">
                        <span className="font-bold text-white text-sm truncate tracking-tight block">{season.name}</span>
                    </div>

                    {/* Slug */}
                    <div className="w-40 shrink-0">
                        <span className="text-[10px] text-white/20 font-mono truncate block">/{season.slug}</span>
                    </div>

                    {/* Series */}
                    <div className="w-32 shrink-0 text-xs text-white/60 truncate">
                        {season.series?.title || "-"}
                    </div>
                    
                    {/* Year */}
                    <div className="w-16 shrink-0 text-center text-xs text-white/60 font-mono">
                        {season.year}
                    </div>

                    {/* Dates */}
                    <div className="w-48 shrink-0 text-[10px] text-white/40 font-mono">
                         {start ? start.toLocaleDateString() : "?"} - {end ? end.toLocaleDateString() : "?"}
                    </div>

                    {/* Actions */}
                    <div className="w-32 shrink-0 flex items-center justify-end gap-1">
                        
                        <form
                            onSubmit={async (e) => {
                                e.preventDefault();
                                const result = await recomputeStandings(season.id);
                                if (result.ok) toast.success(`Standings recomputed for ${season.name}`);
                                else toast.error(result.error);
                            }}
                        >
                            <ConfirmSubmitButton
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-white/20 group-hover:text-white/70 hover:!text-blue-400 hover:bg-white/10 transition-colors"
                                title="Recompute Standings"
                                message="Are you sure you want to recompute standings for this season? This will recalculate all driver points based on race results."
                            >
                                <RefreshCw size={14} />
                            </ConfirmSubmitButton>
                        </form>

                        <Button asChild size="icon" variant="ghost" className="h-7 w-7 text-white/20 group-hover:text-white/70 hover:!text-lsr-orange hover:bg-white/10 transition-colors">
                            <Link href={`/admin/seasons/${season.id}/edit`} title="Edit Details">
                                <Edit size={14} />
                            </Link>
                        </Button>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-white/20 group-hover:text-white/70 hover:bg-white/10 transition-colors">
                                    <MoreVertical size={14} />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="bg-black border-white/10 text-white rounded-none p-1">
                                <form action={deleteSeason.bind(null, season.id)}>
                                    <DropdownMenuItem asChild className="text-red-400 focus:text-red-400 focus:bg-red-400/10 cursor-pointer rounded-none text-[10px] uppercase font-bold tracking-widest">
                                        <button type="submit" className="w-full flex items-center p-2">
                                            <Trash2 size={12} className="mr-2" /> Delete Season
                                        </button>
                                    </DropdownMenuItem>
                                </form>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
                );
            })
        )}
      </div>
    </div>
  );
}
