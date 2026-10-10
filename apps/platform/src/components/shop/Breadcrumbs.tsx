import Link from "next/link";
import { ChevronRight } from "lucide-react";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6 md:mb-8">
      <ol className="flex flex-wrap items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/45">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-2">
            {item.href ? (
              <Link
                href={item.href}
                className="hover:text-lsr-orange transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span aria-current={i === items.length - 1 ? "page" : undefined} className="max-w-[220px] truncate text-white/80">
                {item.label}
              </span>
            )}
            {i < items.length - 1 && (
              <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
