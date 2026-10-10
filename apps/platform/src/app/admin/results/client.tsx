"use client";

import { useState, useMemo } from "react";
import {
  FileJson,
  Search,
  Plus,
  Download,
  Settings,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { uploadResult } from "@/app/admin/results/actions";
import { type RawResultUpload, type User, type Event } from "@prisma/client";
import { cn } from "@/lib/utils";

type ResultWithUser = RawResultUpload & {
  uploadedBy: User;
  event: Event | null;
};

const formSchema = z.object({
  file: z.instanceof(File),
});

type SortField = "uploadedAt" | "filename" | "status";
type SortDirection = "asc" | "desc";

export function ResultsAdminClient({
  results: initialResults,
}: {
  results: ResultWithUser[];
}) {
  const [results, setResults] = useState(initialResults);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("uploadedAt");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setIsUploading(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", values.file);

    try {
      const result = await uploadResult(formData);
      if (!result.ok) {
        setError(result.error);
      } else {
        setResults((prev) => [{ ...result.data, event: null }, ...prev]);
        setIsUploadOpen(false);
      }
    } catch (error) {
      console.error(error);
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setIsUploading(false);
      form.reset();
    }
  };

  const downloadJson = (result: ResultWithUser) => {
    const jsonString = JSON.stringify(result.rawJson, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const SortIndicator = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={10} className="ml-1.5 opacity-20" />;
    return sortDir === "asc" ? <ChevronUp size={10} className="ml-1.5 text-lsr-orange" /> : <ChevronDown size={10} className="ml-1.5 text-lsr-orange" />;
  };

  const filteredAndSortedResults = useMemo(() => {
    let res = [...results];

    // Filter
    if (search) {
      const q = search.toLowerCase();
      res = res.filter(
        (r) =>
          r.filename.toLowerCase().includes(q) ||
          r.status.toLowerCase().includes(q) ||
          r.event?.title.toLowerCase().includes(q)
      );
    }

    // Sort
    res.sort((a, b) => {
      let fieldA: string | number | Date = a[sortField];
      let fieldB: string | number | Date = b[sortField];

      if (sortField === "uploadedAt") {
          fieldA = new Date(a.uploadedAt).getTime();
          fieldB = new Date(b.uploadedAt).getTime();
      }

      if (fieldA === fieldB) return 0;
      
      const comparison = fieldA > fieldB ? 1 : -1;
      return sortDir === "asc" ? comparison : -comparison;
    });

    return res;
  }, [results, search, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
      if (field === "uploadedAt") setSortDir("desc");
    }
  };

  const statusColors: Record<string, string> = {
    UPLOADED: "text-white/40 border-white/20 bg-white/5",
    PARSED: "text-blue-400 border-blue-400/20 bg-blue-400/10",
    INGESTED: "text-green-400 border-green-400/20 bg-green-400/10",
    FAILED: "text-red-400 border-red-400/20 bg-red-400/10",
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
      {/* Toolbar */}
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10 cursor-help">
                <FileJson size={14} className="text-lsr-orange" />
                <span className="font-bold text-white/80 tracking-wider uppercase">Results</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
              <p className="font-bold mb-1 text-lsr-orange">Results Console</p>
              <p className="text-xs text-white/80">
                Upload and manage race result JSON files.
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
            placeholder="Search results..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("uploadedAt")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "uploadedAt" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Date <SortIndicator field="uploadedAt" />
            </Button>
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("filename")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "filename" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Filename <SortIndicator field="filename" />
            </Button>
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("status")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "status" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Status <SortIndicator field="status" />
            </Button>
        </div>

        <div className="flex-1" />

        <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
            <DialogTrigger asChild>
                <Button size="sm" className="bg-lsr-orange hover:bg-lsr-orange/90 text-white border-0 font-bold uppercase tracking-wider text-xs h-8">
                    <Plus size={14} className="mr-2" /> Upload Result
                </Button>
            </DialogTrigger>
            <DialogContent className="bg-black/95 border-white/10 text-white">
                <DialogHeader>
                    <DialogTitle className="text-lsr-orange font-mono uppercase tracking-widest">Upload Result JSON</DialogTitle>
                </DialogHeader>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 mt-4">
                        <FormField
                            control={form.control}
                            name="file"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel className="text-xs uppercase tracking-wider text-white/60">Result File</FormLabel>
                                    <FormControl>
                                        <Input
                                            type="file"
                                            className="bg-white/5 border-white/10 text-white focus:border-lsr-orange file:bg-white/10 file:text-white/70 file:border-0 file:mr-4 file:px-2 file:py-1 file:rounded-sm file:text-xs file:font-mono"
                                            onChange={(e) =>
                                                field.onChange(e.target.files ? e.target.files[0] : null)
                                            }
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        {error && <p className="text-red-400 text-xs font-mono bg-red-400/10 p-2 border border-red-400/20 rounded">{error}</p>}
                        <Button 
                            type="submit" 
                            disabled={isUploading}
                            className="w-full bg-lsr-orange hover:bg-lsr-orange/90 text-white font-bold uppercase tracking-widest text-xs"
                        >
                            {isUploading ? "Uploading..." : "Upload"}
                        </Button>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
      </div>

      {/* Header Labels */}
      <div className="bg-white/5 border-b border-white/10 px-5 py-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
          <div className="w-24 shrink-0 text-left">Uploaded Date</div>
          <div className="w-20 shrink-0 text-left">Uploaded Time</div>
          <div className="w-64 shrink-0">Filename</div>
          <div className="w-40 shrink-0">Uploaded By</div>
          <div className="flex-1">Assigned Event</div>
          <div className="w-24 shrink-0 text-center">Status</div>
          <div className="w-24 shrink-0 text-right">Actions</div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {filteredAndSortedResults.length === 0 ? (
            <div className="flex items-center justify-center h-full text-white/40">
                No results found.
            </div>
        ) : (
            filteredAndSortedResults.map((result) => {
                const date = new Date(result.uploadedAt);
                return (
                <div
                    key={result.id}
                    className="flex items-center gap-4 p-3 hover:bg-white/5 rounded border border-transparent hover:border-white/10 transition-all group"
                >
                    {/* Date */}
                    <div className="w-24 shrink-0 text-xs text-white/60 font-mono">
                        {date.toLocaleDateString()}
                    </div>

                    {/* Time */}
                    <div className="w-20 shrink-0 text-xs text-white/40 font-mono">
                        {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </div>

                    {/* Filename */}
                    <div className="w-64 shrink-0 min-w-0">
                        <span className="font-bold text-white text-sm truncate tracking-tight block">
                            {result.filename}
                        </span>
                    </div>

                    {/* Uploaded By */}
                    <div className="w-40 shrink-0 text-xs text-white/60 truncate flex items-center gap-2">
                        {result.uploadedBy.avatarUrl && (
                             // eslint-disable-next-line @next/next/no-img-element
                             <img src={result.uploadedBy.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                         )}
                         <span>{result.uploadedBy.displayName || result.uploadedBy.email}</span>
                    </div>

                    {/* Assigned Event */}
                    <div className="flex-1 min-w-0">
                        {result.event ? (
                            <span className="text-xs text-white/60 font-bold truncate block">{result.event.title}</span>
                        ) : (
                            <span className="text-[10px] text-white/20 italic">Unassigned</span>
                        )}
                    </div>

                    {/* Status */}
                    <div className="w-24 shrink-0">
                        <Badge variant="outline" className={cn("rounded-sm px-2 py-0.5 text-[9px] uppercase tracking-widest font-bold w-full justify-center", statusColors[result.status] || statusColors.UPLOADED)}>
                            {result.status}
                        </Badge>
                    </div>

                    {/* Actions */}
                    <div className="w-24 shrink-0 flex items-center justify-end gap-1">
                         <Button 
                            size="icon" 
                            variant="ghost" 
                            className="h-7 w-7 text-white/20 group-hover:text-white/70 hover:!text-blue-400 hover:bg-white/10 transition-colors"
                            onClick={() => downloadJson(result)}
                            title="Download JSON"
                        >
                            <Download size={14} />
                        </Button>
                        
                        <Button asChild size="icon" variant="ghost" className="h-7 w-7 text-white/20 group-hover:text-white/70 hover:!text-lsr-orange hover:bg-white/10 transition-colors">
                            <Link href={`/admin/results/${result.id}`} title="Manage Ingest">
                                <Settings size={14} />
                            </Link>
                        </Button>
                    </div>
                </div>
                );
            })
        )}
      </div>
    </div>
  );
}