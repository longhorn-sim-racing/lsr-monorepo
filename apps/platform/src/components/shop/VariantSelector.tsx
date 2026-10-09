"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProductVariant } from "@/lib/shopify/types";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function VariantSelector({
  variants,
  options,
}: {
  variants: ProductVariant[];
  options: { name: string; values: string[] }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // If no options, don't render selector
  if (!options.length || (options.length === 1 && options[0]?.values.length === 1)) {
    return null;
  }

  // Get current selections from URL params (or defaults to first values)
  const getCurrentSelections = (): Record<string, string> => {
    const selections: Record<string, string> = {};
    options.forEach((option) => {
      const paramValue = searchParams.get(option.name.toLowerCase());
      selections[option.name.toLowerCase()] = paramValue || option.values[0];
    });
    return selections;
  };

  // Check if a specific option value is available given current selections of other options
  const isAvailableForSale = (optionName: string, value: string): boolean => {
    const currentSelections = getCurrentSelections();

    // Build the hypothetical selection with this option value
    const hypotheticalSelections = {
      ...currentSelections,
      [optionName.toLowerCase()]: value,
    };

    // Find if any variant matches all these selections AND is available
    return variants.some((variant) => {
      const matchesAllOptions = variant.selectedOptions.every(
        (opt) => hypotheticalSelections[opt.name.toLowerCase()] === opt.value
      );
      return matchesAllOptions && variant.availableForSale;
    });
  };

  // Handle option change
  const handleOptionChange = (optionName: string, value: string) => {
    const newParams = new URLSearchParams(searchParams.toString());
    newParams.set(optionName.toLowerCase(), value);
    router.replace(`${pathname}?${newParams.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      {options.map((option) => {
        const currentValue =
          searchParams.get(option.name.toLowerCase()) || option.values[0];

        return (
          <div key={option.name}>
            <div className="mb-3 flex items-baseline gap-2 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/55">
              {option.name}
              <span className="text-white">{currentValue}</span>
            </div>

            {/* Mobile: Dropdown selector */}
            <div className="md:hidden">
              <Select
                value={currentValue}
                onValueChange={(value) => handleOptionChange(option.name, value)}
              >
                <SelectTrigger aria-label={option.name} className="h-12 w-full rounded-none border-white/15 bg-white/[0.04] text-base font-bold uppercase tracking-wider text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-lsr-charcoal border-white/10 rounded-none">
                  {option.values.map((value) => {
                    const isAvailable = isAvailableForSale(option.name, value);
                    return (
                      <SelectItem
                        key={value}
                        value={value}
                        disabled={!isAvailable}
                        className={cn(
                          "font-bold uppercase tracking-wider rounded-none cursor-pointer",
                          !isAvailable && "text-white/30 line-through"
                        )}
                      >
                        {value}
                        {!isAvailable && " (Sold Out)"}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Desktop: Button grid */}
            <div className="hidden md:flex flex-wrap gap-2">
              {option.values.map((value) => {
                const isActive = currentValue === value;
                const isAvailable = isAvailableForSale(option.name, value);

                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleOptionChange(option.name, value)}
                    disabled={!isAvailable}
                    aria-pressed={isActive}
                    className={cn(
                      "h-11 min-w-12 px-4 border font-sans text-sm font-bold uppercase tracking-wider transition-colors",
                      isActive
                        ? "bg-lsr-orange border-lsr-orange text-white"
                        : isAvailable
                          ? "bg-white/[0.03] border-white/15 text-white/75 hover:border-white/40 hover:text-white"
                          : "bg-transparent border-white/5 text-white/20 line-through cursor-not-allowed"
                    )}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
