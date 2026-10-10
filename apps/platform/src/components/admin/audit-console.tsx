"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useDebounce } from "use-debounce";
import { Loader2, RefreshCw, Search, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuditLog } from "@prisma/client";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type AuditLogWithActor = AuditLog & {
  actor: {
    id: string;
    displayName: string;
    handle: string;
    avatarUrl: string | null;
  } | null;
  targetUser: {
    id: string;
    displayName: string;
    handle: string;
    avatarUrl: string | null;
  } | null;
};

export function AuditConsole() {
  const [logs, setLogs] = useState<AuditLogWithActor[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The next page to load; a ref so fetchLogs keeps one identity while paging
  const pageRef = useRef(1);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebounce(search, 500);
  
  // Filters
  const [actionType, setActionType] = useState<string>("");
  const [entityType, setEntityType] = useState<string>("");
  
  // Live Tail
  const [liveTail, setLiveTail] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Detail View
  const [selectedLog, setSelectedLog] = useState<AuditLogWithActor | null>(null);

  const fetchLogs = useCallback(async (reset = false) => {
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const query = new URLSearchParams({
        page: reset ? "1" : pageRef.current.toString(),
        limit: "50",
      });
      if (debouncedSearch) query.set("search", debouncedSearch);
      if (actionType) query.set("actionType", actionType);
      if (entityType) query.set("entityType", entityType);

      const res = await fetch(`/api/admin/audit-logs?${query.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();

      if (reset) {
        setLogs(data.items);
        pageRef.current = 2;
      } else {
        setLogs((prev) => {
           // Dedup in case of overlap
           const ids = new Set(prev.map(l => l.id));
           const newItems = data.items.filter((l: AuditLogWithActor) => !ids.has(l.id));
           return [...prev, ...newItems];
        });
        pageRef.current += 1;
      }
      setHasMore(pageRef.current <= data.pagination.totalPages);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch, actionType, entityType]);

  // Initial fetch, and again when the search or filters change
  useEffect(() => {
    fetchLogs(true);
  }, [fetchLogs]);

  // Polling for live tail
  useEffect(() => {
    if (liveTail) {
      pollIntervalRef.current = setInterval(() => {
        // Simple strategy: just fetch page 1 and prepend new items?
        // Or just re-fetch everything? 
        // For simple console, let's just re-fetch page 1 silently.
        fetchLogs(true); 
      }, 3000);
    } else if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [liveTail, fetchLogs]);


  return (
    <div className="flex h-[calc(100vh-6rem)] gap-4">
      {/* Console Area */}
      <div className="flex-1 flex flex-col border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
        {/* Toolbar */}
        <div className="bg-white/5 p-2 border-b border-white/10 flex items-center gap-2 flex-wrap">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <div className="flex items-center gap-2 bg-black/50 px-2 py-1 rounded border border-white/10 cursor-help">
                  <Terminal size={14} className="text-lsr-orange" />
                  <span className="font-bold text-white/80">AUDIT CONSOLE</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
                <p className="font-bold mb-1 text-lsr-orange">Audit Console</p>
                <p className="text-xs text-white/80">
                  A comprehensive log of all administrative actions. This ensures accountability and transparency for changes made by officers and admins.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
          <div className="h-4 w-px bg-white/10 mx-2" />

          <div className="flex items-center gap-2 relative">
             <Search size={14} className="absolute left-2 text-white/40" />
             <input 
               value={search}
               onChange={(e) => setSearch(e.target.value)}
               placeholder="Search logs..." 
               className="bg-black/50 border border-white/10 rounded pl-8 pr-2 py-1 text-xs text-white focus:outline-none focus:border-lsr-orange w-48"
             />
          </div>

          <div className="flex items-center gap-2">
            <input 
               value={actionType}
               onChange={(e) => setActionType(e.target.value)}
               placeholder="Action Type..." 
               className="bg-black/50 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-lsr-orange w-32"
             />
             <input 
               value={entityType}
               onChange={(e) => setEntityType(e.target.value)}
               placeholder="Entity Type..." 
               className="bg-black/50 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-lsr-orange w-32"
             />
          </div>

          <div className="flex-1" />

          <button 
            onClick={() => setLiveTail(!liveTail)}
            className={cn(
              "flex items-center gap-2 px-2 py-1 rounded text-xs border border-transparent transition-colors",
              liveTail ? "bg-lsr-orange/20 text-lsr-orange border-lsr-orange/50" : "text-white/60 hover:text-white"
            )}
          >
            <RefreshCw size={12} className={cn(liveTail && "animate-spin")} />
            Live Tail {liveTail ? "ON" : "OFF"}
          </button>
        </div>

        {/* Logs List */}
        <div className="flex-1 overflow-auto p-4 space-y-1">
          {loading ? (
             <div className="flex items-center justify-center h-full text-white/40 gap-2">
                <Loader2 className="animate-spin" /> Loading logs...
             </div>
          ) : logs.length === 0 ? (
             <div className="flex items-center justify-center h-full text-white/40">
                No logs found.
             </div>
          ) : (
            <>
              {logs.map((log) => (
                <div 
                  key={log.id} 
                  onClick={() => setSelectedLog(log)}
                  className={cn(
                    "flex items-start gap-3 p-1 hover:bg-white/5 cursor-pointer rounded select-none group border-l-2 border-transparent",
                    selectedLog?.id === log.id ? "bg-white/10 border-lsr-orange" : "border-transparent"
                  )}
                >
                  <span className="text-white/40 text-[10px] whitespace-nowrap pt-0.5 w-32">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                  
                  <span className="text-lsr-orange text-xs font-bold whitespace-nowrap w-24 truncate flex items-center gap-1">
                     {log.actor?.handle || "System"}
                     {log.targetUser && (
                        <span className="text-white/40 font-normal">→ {log.targetUser.handle}</span>
                     )}
                  </span>
                  
                  <span className="text-blue-400 text-xs font-bold whitespace-nowrap w-32 truncate">
                    {log.actionType}
                  </span>

                  <span className="text-white/80 text-xs truncate flex-1">
                     <span className="text-white/40 mr-2">[{log.entityType}:{log.entityId}]</span>
                     {log.summary}
                  </span>
                </div>
              ))}
              
              {/* Load More Trigger */}
              {!liveTail && hasMore && (
                 <div className="pt-4 text-center">
                    <button 
                       onClick={() => fetchLogs()} 
                       disabled={loadingMore || logs.length === 0}
                       className="text-xs text-white/40 hover:text-white disabled:opacity-50"
                    >
                       {loadingMore ? "Loading..." : "Load More"}
                    </button>
                 </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Details Drawer */}
      {selectedLog && (
        <div className="w-96 border-l border-white/10 bg-black/90 p-4 overflow-auto flex flex-col gap-4">
           <div className="flex justify-between items-start">
             <h3 className="text-lg font-bold text-white">Log Details</h3>
             <button onClick={() => setSelectedLog(null)} className="text-white/40 hover:text-white">
               <X size={16} />
             </button>
           </div>

           <div className="space-y-4 text-sm">
             <div>
               <label className="text-xs text-white/40 uppercase font-bold block mb-1">ID</label>
               <div className="font-mono text-white/80 text-xs break-all">{selectedLog.id}</div>
             </div>

             <div className="grid grid-cols-2 gap-4">
                <div>
                   <label className="text-xs text-white/40 uppercase font-bold block mb-1">Actor</label>
                   <div className="text-white flex items-center gap-2">
                      {selectedLog.actor?.avatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element -- avatar URLs can come from any host, which next/image would reject
                        <img src={selectedLog.actor.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
                      )}
                      {selectedLog.actor?.displayName || "System"}
                   </div>
                </div>
                <div>
                   <label className="text-xs text-white/40 uppercase font-bold block mb-1">Target User</label>
                   <div className="text-white flex items-center gap-2">
                      {selectedLog.targetUser ? (
                        <>
                          {selectedLog.targetUser.avatarUrl && (
                            // eslint-disable-next-line @next/next/no-img-element -- avatar URLs can come from any host, which next/image would reject
                            <img src={selectedLog.targetUser.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
                          )}
                          <span className="font-mono">{selectedLog.targetUser.displayName} (@{selectedLog.targetUser.handle})</span>
                        </>
                      ) : (
                         <span className="font-mono text-white/40">-</span>
                      )}
                   </div>
                </div>
             </div>

             <div>
               <label className="text-xs text-white/40 uppercase font-bold block mb-1">Action</label>
               <div className="bg-white/5 p-2 rounded border border-white/10 font-mono text-xs text-lsr-orange">
                 {selectedLog.actionType}
               </div>
             </div>
             
             <div>
               <label className="text-xs text-white/40 uppercase font-bold block mb-1">Entity</label>
               <div className="bg-white/5 p-2 rounded border border-white/10 font-mono text-xs">
                 {selectedLog.entityType} : {selectedLog.entityId}
               </div>
             </div>

             <div>
               <label className="text-xs text-white/40 uppercase font-bold block mb-1">Summary</label>
               <p className="text-white/80">{selectedLog.summary}</p>
             </div>

             {selectedLog.before && (
                <div>
                   <label className="text-xs text-white/40 uppercase font-bold block mb-1">Before</label>
                   <pre className="bg-black p-2 rounded border border-white/10 text-[10px] text-red-300 overflow-auto max-h-40">
                      {JSON.stringify(selectedLog.before, null, 2)}
                   </pre>
                </div>
             )}

             {selectedLog.after && (
                <div>
                   <label className="text-xs text-white/40 uppercase font-bold block mb-1">After</label>
                   <pre className="bg-black p-2 rounded border border-white/10 text-[10px] text-green-300 overflow-auto max-h-40">
                      {JSON.stringify(selectedLog.after, null, 2)}
                   </pre>
                </div>
             )}
             
              {selectedLog.metadata && (
                <div>
                   <label className="text-xs text-white/40 uppercase font-bold block mb-1">Metadata</label>
                   <pre className="bg-black p-2 rounded border border-white/10 text-[10px] text-blue-300 overflow-auto max-h-40">
                      {JSON.stringify(selectedLog.metadata, null, 2)}
                   </pre>
                </div>
             )}
           </div>
        </div>
      )}
    </div>
  );
}
