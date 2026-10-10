"use client";

import { useState, useMemo } from "react";
import { DriverIdentity, User } from "@prisma/client";
import { Search, ArrowUpDown, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { updateDriverMapping, searchUsers } from "@/app/admin/drivers/actions";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

type DriverWithUser = DriverIdentity & { user: User | null };

type DriversConsoleProps = {
    initialDrivers: DriverWithUser[];
};

type SortField = "lastSeenName" | "mappedUser" | "guid" | "status";
type SortDirection = "asc" | "desc";

export function DriversConsole({ initialDrivers }: DriversConsoleProps) {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("status");
  const [sortDir, setSortDir] = useState<SortDirection>("asc"); // Unmapped first

  const SortIndicator = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={10} className="ml-1.5 opacity-20" />;
    return sortDir === "asc" ? <ChevronUp size={10} className="ml-1.5 text-lsr-orange" /> : <ChevronDown size={10} className="ml-1.5 text-lsr-orange" />;
  };

  const ChevronUp = ({ size, className }: { size: number, className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m18 15-6-6-6 6"/></svg>
  );
  const ChevronDown = ({ size, className }: { size: number, className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m6 9 6 6 6-6"/></svg>
  );

  const filteredAndSortedDrivers = useMemo(() => {
    let result = [...initialDrivers];

    // Filter
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (d) =>
          d.lastSeenName.toLowerCase().includes(q) ||
          d.driverGuid.toLowerCase().includes(q) ||
          (d.user?.displayName || "").toLowerCase().includes(q)
      );
    }

    // Sort
    result.sort((a, b) => {
      let fieldA: string | number;
      let fieldB: string | number;

      if (sortField === "lastSeenName") {
          fieldA = a.lastSeenName.toLowerCase();
          fieldB = b.lastSeenName.toLowerCase();
      } else if (sortField === "mappedUser") {
          fieldA = (a.user?.displayName || "").toLowerCase();
          fieldB = (b.user?.displayName || "").toLowerCase();
      } else if (sortField === "guid") {
          fieldA = a.driverGuid.toLowerCase();
          fieldB = b.driverGuid.toLowerCase();
      } else if (sortField === "status") {
          // Unmapped (no user) first -> 0
          fieldA = a.user ? 1 : 0;
          fieldB = b.user ? 1 : 0;
      } else {
          fieldA = 0;
          fieldB = 0;
      }

      if (fieldA === fieldB) return 0;
      
      const comparison = fieldA > fieldB ? 1 : -1;
      return sortDir === "asc" ? comparison : -comparison;
    });

    return result;
  }, [initialDrivers, search, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
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
                <Users size={14} className="text-lsr-orange" />
                <span className="font-bold text-white/80 tracking-wider uppercase">Driver Mappings</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
              <p className="font-bold mb-1 text-lsr-orange">Drivers Console</p>
              <p className="text-xs text-white/80">
                Link game driver identities (GUIDs) to registered site users for consistent tracking across events.
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
            placeholder="Search drivers..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("status")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "status" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Status <SortIndicator field="status" />
            </Button>
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("lastSeenName")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "lastSeenName" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Name <SortIndicator field="lastSeenName" />
            </Button>
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("mappedUser")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "mappedUser" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                User <SortIndicator field="mappedUser" />
            </Button>
        </div>
      </div>

      {/* Header Labels */}
      <div className="bg-white/5 border-b border-white/10 px-5 py-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
        <div className="w-64 shrink-0">Driver GUID</div>
        <div className="flex-1 min-w-[200px]">Last Seen Name</div>
        <div className="flex-1 min-w-[200px]">Mapped User</div>
        <div className="w-32 shrink-0 text-right">Actions</div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {filteredAndSortedDrivers.length === 0 ? (
            <div className="flex items-center justify-center h-full text-white/40">
                No drivers found.
            </div>
        ) : (
            filteredAndSortedDrivers.map((driver) => (
                <DriverRow key={driver.id} driver={driver} />
            ))
        )}
      </div>
    </div>
  );
}

function DriverRow({ driver }: { driver: DriverWithUser }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Partial<User>[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const router = useRouter();

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    const results = await searchUsers(query);
    setSearchResults(results);
    setIsSearching(false);
  };

  const handleSelect = async (user: Partial<User> | null) => {
      await updateDriverMapping(driver.id, user ? user.id! : null);
      setIsOpen(false);
      router.refresh(); 
  };

  return (
    <div className="flex items-center gap-4 p-3 hover:bg-white/5 rounded border border-transparent hover:border-white/10 transition-all group">
        {/* GUID */}
        <div className="w-64 shrink-0 flex items-center gap-2 overflow-hidden">
            <span className="font-mono text-xs text-white/60 truncate" title={driver.driverGuid}>{driver.driverGuid}</span>
            {!driver.user && (
                <Badge variant="destructive" className="h-4 px-1 text-[9px] uppercase tracking-widest shrink-0">Unmapped</Badge>
            )}
        </div>

        {/* Last Seen Name */}
        <div className="flex-1 min-w-[200px] text-sm font-medium text-white truncate">
            {driver.lastSeenName}
        </div>

        {/* Mapped User */}
        <div className="flex-1 min-w-[200px] text-sm truncate">
            {driver.user ? (
                <div className="flex items-center gap-2 text-green-400">
                    {driver.user.avatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element -- avatar URLs can come from any host, which next/image would reject
                        <img src={driver.user.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                    )}
                    <span className="font-bold">{driver.user.displayName}</span>
                    <span className="text-xs text-white/40">@{driver.user.handle}</span>
                </div>
            ) : (
                <span className="text-white/20 italic text-xs">-</span>
            )}
        </div>

        {/* Actions */}
        <div className="w-32 shrink-0 flex items-center justify-end gap-1">
            <Popover open={isOpen} onOpenChange={(open) => {
                setIsOpen(open);
                if(open) {
                    setSearchQuery("");
                    setSearchResults([]);
                }
            }}>
                <PopoverTrigger asChild>
                    <Button 
                        variant={!driver.user ? "default" : "ghost"} 
                        size="sm" 
                        className={cn(
                            "h-7 text-xs uppercase tracking-wider font-bold",
                            !driver.user ? "bg-lsr-orange hover:bg-lsr-orange/90 text-white" : "text-white/40 hover:text-white bg-transparent hover:bg-white/10"
                        )}
                    >
                        {!driver.user ? "Map User" : "Change"}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 bg-black border border-white/10 p-2 shadow-xl" side="left">
                    <div className="flex flex-col gap-2">
                        <h4 className="font-bold text-xs text-white uppercase tracking-widest mb-1">Select User</h4>
                        <Input 
                            placeholder="Search name, email..." 
                            value={searchQuery}
                            onChange={(e) => handleSearch(e.target.value)}
                            className="bg-white/5 border-white/10 text-white h-8 text-xs"
                            autoFocus
                        />
                        <div className="mt-1 max-h-48 overflow-auto space-y-1">
                            {isSearching && <p className="text-[10px] text-white/40 p-2">Searching...</p>}
                            
                            <Button 
                                variant="ghost" 
                                className="w-full justify-start text-red-400 hover:text-red-300 hover:bg-red-400/10 h-8 text-xs"
                                onClick={() => handleSelect(null)}
                            >
                                Unmap (Clear)
                            </Button>
                            
                            {searchResults.map(u => (
                                <Button 
                                    key={u.id} 
                                    variant="ghost" 
                                    className="w-full justify-start h-auto py-2 hover:bg-white/10"
                                    onClick={() => handleSelect(u)}
                                >
                                    <div className="flex flex-col items-start text-left">
                                        <span className="font-bold text-white text-xs">{u.displayName}</span>
                                        <span className="text-[10px] text-white/40">@{u.handle}</span>
                                    </div>
                                </Button>
                            ))}
                            
                            {searchQuery.length > 1 && searchResults.length === 0 && !isSearching && (
                                <p className="text-[10px] text-white/40 text-center py-2">No users found</p>
                            )}
                        </div>
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    </div>
  );
}
