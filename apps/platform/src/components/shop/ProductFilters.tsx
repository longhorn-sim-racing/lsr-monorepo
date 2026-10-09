"use client";

import { useState, useMemo } from "react";
import { Product } from "@/lib/shopify/types";
import { Search, X } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { cn } from "@/lib/utils";

interface ProductFiltersProps {
  products: Product[];
  onFilter: (filtered: Product[]) => void;
}

export function ProductFilters({ products, onFilter }: ProductFiltersProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeType, setActiveType] = useState<string | null>(null);

  // Extract unique product types
  const productTypes = useMemo(() => {
    const types = new Set<string>();
    products.forEach((p) => {
      if (p.productType) {
        types.add(p.productType);
      }
    });
    return Array.from(types).sort();
  }, [products]);

  // Filter logic
  const applyFilters = useDebouncedCallback(
    (search: string, type: string | null) => {
      let filtered = products;

      // Filter by search term
      if (search) {
        const term = search.toLowerCase();
        filtered = filtered.filter(
          (p) =>
            p.title.toLowerCase().includes(term) ||
            p.description.toLowerCase().includes(term) ||
            p.productType.toLowerCase().includes(term)
        );
      }

      // Filter by product type
      if (type) {
        filtered = filtered.filter((p) => p.productType === type);
      }

      onFilter(filtered);
    },
    150
  );

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    applyFilters(value, activeType);
  };

  const handleTypeChange = (type: string | null) => {
    setActiveType(type);
    applyFilters(searchTerm, type);
  };

  const clearFilters = () => {
    setSearchTerm("");
    setActiveType(null);
    onFilter(products);
  };

  const hasActiveFilters = searchTerm || activeType;

  return (
    <div className="space-y-4 mb-8">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-white/40" aria-hidden />
        <label htmlFor="shop-search" className="sr-only">Search the shop</label>
        <input
          id="shop-search"
          type="search"
          placeholder="Search the shop"
          value={searchTerm}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="h-12 w-full border border-white/15 bg-white/[0.04] pl-12 pr-12 font-sans text-base text-white placeholder:text-white/35 transition-colors focus:border-lsr-orange focus:outline-none focus:ring-1 focus:ring-lsr-orange md:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {searchTerm && (
          <button
            type="button"
            onClick={() => handleSearchChange("")}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Category filters */}
      {productTypes.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={!activeType}
            onClick={() => handleTypeChange(null)}
            className={cn(
              "h-10 px-4 font-sans text-[11px] font-bold uppercase tracking-[0.2em] border transition-colors",
              !activeType
                ? "bg-lsr-orange border-lsr-orange text-white"
                : "bg-transparent border-white/10 text-white/60 hover:border-white/30 hover:text-white"
            )}
          >
            All
          </button>
          {productTypes.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={activeType === type}
              onClick={() => handleTypeChange(type)}
              className={cn(
                "h-10 px-4 font-sans text-[11px] font-bold uppercase tracking-[0.2em] border transition-colors",
                activeType === type
                  ? "bg-lsr-orange border-lsr-orange text-white"
                  : "bg-transparent border-white/10 text-white/60 hover:border-white/30 hover:text-white"
              )}
            >
              {type}
            </button>
          ))}
        </div>
      )}

      {/* Active filters indicator */}
      {hasActiveFilters && (
        <div className="flex items-center gap-2 text-sm text-white/60">
          <span>Filtering results</span>
          <button
            type="button"
            onClick={clearFilters}
            className="text-lsr-orange hover:text-white transition-colors underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
