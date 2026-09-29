"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebouncedCallback } from "use-debounce";
import { Loader2, Search, X } from "lucide-react";
import { PAYMENT_KIND_LABELS, PAYMENT_STATUSES } from "@/lib/payments";

const selectClass =
  "h-8 rounded-none border border-white/10 bg-black/50 px-2 text-xs uppercase tracking-wider text-white focus:outline-none focus:border-lsr-orange transition-colors [&>option]:bg-lsr-charcoal";

export function PaymentsFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const urlQuery = searchParams.get("q") ?? "";
  const [term, setTerm] = useState(urlQuery);
  const [seenQuery, setSeenQuery] = useState(urlQuery);

  // Follow URL changes made elsewhere (back button, sidebar link) without clobbering typing.
  if (urlQuery !== seenQuery) {
    setSeenQuery(urlQuery);
    if (urlQuery !== term.trim()) setTerm(urlQuery);
  }

  const status = searchParams.get("status") ?? "";
  const kind = searchParams.get("kind") ?? "";
  const hasFilters = Boolean(status || kind || urlQuery);

  const navigate = (next: URLSearchParams) => {
    next.delete("page");
    const query = next.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    navigate(next);
  };

  const applySearch = useDebouncedCallback((value: string) => setParam("q", value.trim()), 300);

  const clear = () => {
    applySearch.cancel();
    setTerm("");
    navigate(new URLSearchParams());
  };

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative flex flex-1 items-center max-w-sm">
        <Search size={14} className="absolute left-3 text-white/40" />
        <input
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            applySearch(e.target.value);
          }}
          placeholder="Search name, handle, email..."
          className="w-full h-8 rounded-none border border-white/10 bg-black/50 pl-9 pr-3 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
        />
      </div>

      <select
        aria-label="Status"
        value={status}
        onChange={(e) => setParam("status", e.target.value)}
        className={selectClass}
      >
        <option value="">All statuses</option>
        {PAYMENT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </option>
        ))}
      </select>

      <select
        aria-label="Kind"
        value={kind}
        onChange={(e) => setParam("kind", e.target.value)}
        className={selectClass}
      >
        <option value="">All kinds</option>
        {Object.entries(PAYMENT_KIND_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      {hasFilters && (
        <button
          type="button"
          onClick={clear}
          className="flex h-8 items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-widest text-lsr-orange hover:text-white transition-colors"
        >
          <X size={12} />
          Clear
        </button>
      )}

      {isPending && <Loader2 size={14} className="animate-spin text-white/40" />}
    </div>
  );
}
