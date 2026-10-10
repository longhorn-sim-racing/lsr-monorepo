"use client";

import { useState, useMemo } from "react";
import { Post, User, Tag } from "@prisma/client";
import { Search, Plus, ArrowUpDown, MoreVertical, Edit, Trash2, Newspaper } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { deletePost } from "@/app/admin/news/actions";
import { cn } from "@/lib/utils";

type PostWithAuthor = Post & {
  author: User | null;
  tags: Tag[];
};

type NewsConsoleProps = {
  initialPosts: PostWithAuthor[];
};

type SortField = "title" | "date" | "status";
type SortDirection = "asc" | "desc";

export function NewsConsole({ initialPosts }: NewsConsoleProps) {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

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

  const filteredAndSortedPosts = useMemo(() => {
    let result = [...initialPosts];

    // Filter
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.author?.displayName || "").toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          p.tags.some(t => t.name.toLowerCase().includes(q))
      );
    }

    // Sort
    result.sort((a, b) => {
      let fieldA: string | number;
      let fieldB: string | number;

      if (sortField === "date") {
         fieldA = a.publishedAt ? new Date(a.publishedAt).getTime() : (new Date(a.createdAt).getTime());
         fieldB = b.publishedAt ? new Date(b.publishedAt).getTime() : (new Date(b.createdAt).getTime());
      } else if (sortField === "status") {
          // published > draft
          fieldA = a.publishedAt ? 1 : 0;
          fieldB = b.publishedAt ? 1 : 0;
      } else {
          fieldA = a.title.toLowerCase();
          fieldB = b.title.toLowerCase();
      }

      if (fieldA === fieldB) return 0;
      
      const comparison = fieldA > fieldB ? 1 : -1;
      return sortDir === "asc" ? comparison : -comparison;
    });

    return result;
  }, [initialPosts, search, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
      if (field === "date") setSortDir("desc");
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
                <Newspaper size={14} className="text-lsr-orange" />
                <span className="font-bold text-white/80 tracking-wider uppercase">News Articles</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
              <p className="font-bold mb-1 text-lsr-orange">News Console</p>
              <p className="text-xs text-white/80">
                Manage news articles, blog posts, and announcements. Control visibility and publication status.
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
            placeholder="Search news..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("date")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "date" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Date <SortIndicator field="date" />
            </Button>
            <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => toggleSort("title")}
                className={cn("text-xs uppercase tracking-wider h-8", sortField === "title" ? "text-lsr-orange bg-lsr-orange/10" : "text-white/60")}
            >
                Title <SortIndicator field="title" />
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

        <Button asChild size="sm" className="bg-lsr-orange hover:bg-lsr-orange/90 text-white border-0 font-bold uppercase tracking-wider text-xs h-8">
          <Link href="/admin/news/new">
            <Plus size={14} className="mr-2" /> Create Article
          </Link>
        </Button>
      </div>

      {/* Header Labels */}
      <div className="bg-white/5 border-b border-white/10 px-5 py-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
        <div className="flex-1 min-w-[200px]">Title</div>
        <div className="w-32 shrink-0">Author</div>
        <div className="w-24 shrink-0 text-center">Status</div>
        <div className="w-48 shrink-0">Tags</div>
        <div className="w-32 shrink-0 text-right">Date</div>
        <div className="w-24 shrink-0 text-right">Actions</div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {filteredAndSortedPosts.length === 0 ? (
            <div className="flex items-center justify-center h-full text-white/40">
                No articles found matching your search.
            </div>
        ) : (
            filteredAndSortedPosts.map((post) => {
                const isPublished = !!post.publishedAt;
                const date = post.publishedAt || post.createdAt;
                
                return (
                <div
                    key={post.id}
                    className="flex items-center gap-4 p-3 hover:bg-white/5 rounded border border-transparent hover:border-white/10 transition-all group"
                >
                    {/* Title */}
                    <div className="flex-1 min-w-[200px]">
                        <span className="font-bold text-white text-sm truncate tracking-tight block">{post.title}</span>
                        <span className="text-[10px] text-white/20 font-mono truncate block">/{post.slug}</span>
                    </div>

                    {/* Author */}
                    <div className="w-32 shrink-0 text-xs text-white/60 truncate flex items-center gap-2">
                         {post.author?.avatarUrl && (
                             // eslint-disable-next-line @next/next/no-img-element -- avatar URLs can come from any host, which next/image would reject
                             <img src={post.author.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                         )}
                         <span>{post.author?.displayName || "-"}</span>
                    </div>
                    
                    {/* Status */}
                    <div className="w-24 shrink-0 text-center">
                        <Badge variant="outline" className={cn("rounded-sm px-2 py-0.5 text-[9px] uppercase tracking-widest font-bold", isPublished ? "text-green-400 border-green-400/20 bg-green-400/10" : "text-yellow-400 border-yellow-400/20 bg-yellow-400/10")}>
                             {isPublished ? "Published" : "Draft"}
                        </Badge>
                    </div>

                    {/* Tags */}
                     <div className="w-48 shrink-0 flex flex-wrap gap-1">
                         {post.tags.map(tag => (
                             <Badge key={tag.id} variant="outline" className="text-[8px] px-1 py-0 border-white/10 text-white/40">
                                 {tag.name}
                             </Badge>
                         ))}
                         {post.tags.length === 0 && <span className="text-white/10 text-[10px]">-</span>}
                     </div>

                    {/* Date */}
                    <div className="w-32 shrink-0 text-right text-[10px] text-white/40 font-mono">
                         {new Date(date).toLocaleDateString()}
                    </div>

                    {/* Actions */}
                    <div className="w-24 shrink-0 flex items-center justify-end gap-1">
                        <Button asChild size="icon" variant="ghost" className="h-7 w-7 text-white/20 group-hover:text-white/70 hover:!text-lsr-orange hover:bg-white/10 transition-colors">
                            <Link href={`/admin/news/${post.id}`} title="Edit Details">
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
                                <form action={deletePost.bind(null, post.id)}>
                                    <DropdownMenuItem asChild className="text-red-400 focus:text-red-400 focus:bg-red-400/10 cursor-pointer rounded-none text-[10px] uppercase font-bold tracking-widest">
                                        <button type="submit" className="w-full flex items-center p-2">
                                            <Trash2 size={12} className="mr-2" /> Delete
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
