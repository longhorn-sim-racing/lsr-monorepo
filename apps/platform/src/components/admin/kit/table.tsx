"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { SearchInput, Toolbar } from "./filters"
import { EmptyState } from "./surface"

/* Plain table pieces, for server-rendered or paginated lists. DataTable below builds on them. */

export function Table({ className, minWidth = 640, children }: { className?: string; minWidth?: number; children: React.ReactNode }) {
  return (
    <div className={cn("relative min-w-0 overflow-x-auto rounded-lg border bg-card", className)}>
      <table className="w-full border-collapse text-[13px] tabular-nums" style={{ minWidth }}>
        {children}
      </table>
    </div>
  )
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b bg-admin-surface text-left">
      <tr>{children}</tr>
    </thead>
  )
}

export function TH({ className, children, ...props }: React.ComponentProps<"th">) {
  return (
    <th scope="col" className={cn("whitespace-nowrap px-3 py-2 text-xs font-semibold text-muted-foreground", className)} {...props}>
      {children}
    </th>
  )
}

export function TR({ className, selected, children, ...props }: React.ComponentProps<"tr"> & { selected?: boolean }) {
  return (
    <tr className={cn("border-b border-admin-row last:border-b-0", selected && "bg-admin-selected", className)} {...props}>
      {children}
    </tr>
  )
}

export function TD({ className, children, ...props }: React.ComponentProps<"td">) {
  return (
    <td className={cn("px-3 py-2 align-middle", className)} {...props}>
      {children}
    </td>
  )
}

/** Two-line cell: a bold primary line and a muted second line. */
export function CellStack({ primary, secondary }: { primary: React.ReactNode; secondary?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-semibold">{primary}</span>
      {secondary && <span className="truncate text-xs text-admin-subtle">{secondary}</span>}
    </div>
  )
}

export function TableFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs text-admin-subtle">{children}</div>
}

/* DataTable: a client-side list with search, sortable columns, row links and row actions. */

type SortValue = string | number | Date | boolean | null | undefined

export type Column<T> = {
  id: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  /** Makes the column sortable */
  sortValue?: (row: T) => SortValue
  align?: "left" | "right"
  /** Hide on narrow screens */
  hideBelow?: "sm" | "md" | "lg"
  className?: string
}

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
}

/** Sort order for two values; empty values always go last, whichever way the column is sorted. */
function compare(a: SortValue, b: SortValue, desc: boolean) {
  const empty = (v: SortValue) => v == null || v === ""
  if (empty(a) && empty(b)) return 0
  if (empty(a)) return 1
  if (empty(b)) return -1
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  const order = typeof x === "string" && typeof y === "string" ? x.localeCompare(y, undefined, { sensitivity: "base", numeric: true }) : x! < y! ? -1 : x! > y! ? 1 : 0
  return desc ? -order : order
}

/** True when a click started on something interactive inside the row (so the row shouldn't navigate). */
function fromInteractive(event: React.MouseEvent) {
  return (event.target as HTMLElement).closest("a, button, input, select, textarea, label, [role=menuitem]") !== null
}

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  search,
  filters,
  actions,
  rowActions,
  rowHref,
  onRowClick,
  selectedId,
  initialSort,
  empty,
  noun = { one: "item", many: "items" },
  minWidth,
}: {
  rows: T[]
  columns: Column<T>[]
  getRowId: (row: T) => string
  /** Adds a search box; `text` returns the searchable text for a row */
  search?: { placeholder: string; text: (row: T) => string }
  /** Filters shown next to the search box (Segmented, FilterMenu, selects). Filter `rows` yourself. */
  filters?: React.ReactNode
  /** Buttons on the right of the toolbar */
  actions?: React.ReactNode
  rowActions?: (row: T) => React.ReactNode
  /** Clicking a row (outside its links and buttons) opens this page */
  rowHref?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  selectedId?: string
  initialSort?: { id: string; desc?: boolean }
  /** Shown when there are no rows at all (search misses get their own message) */
  empty?: React.ReactNode
  /** For the "Showing 3 of 7 events" line */
  noun?: { one: string; many: string }
  minWidth?: number
}) {
  const router = useRouter()
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState(initialSort ?? null)

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = q && search ? rows.filter((row) => search.text(row).toLowerCase().includes(q)) : rows
    const column = sort && columns.find((c) => c.id === sort.id)
    if (column?.sortValue) {
      const value = column.sortValue
      const desc = !!sort?.desc
      list = [...list].sort((a, b) => compare(value(a), value(b), desc))
    }
    return list
  }, [rows, columns, query, search, sort])

  const toggleSort = (id: string) =>
    setSort((current) => (current?.id !== id ? { id, desc: false } : current.desc ? null : { id, desc: true }))

  const clickable = !!(rowHref || onRowClick)
  const hasToolbar = !!(search || filters || actions)

  return (
    <div className="min-w-0">
      {hasToolbar && (
        <Toolbar actions={actions}>
          {search && <SearchInput value={query} onChange={setQuery} placeholder={search.placeholder} />}
          {filters}
        </Toolbar>
      )}
      <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-[13px] tabular-nums" style={{ minWidth: minWidth ?? 640 }}>
            <thead className="border-b bg-admin-surface text-left">
              <tr>
                {columns.map((column) => {
                  const sorted = sort?.id === column.id
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      aria-sort={sorted ? (sort?.desc ? "descending" : "ascending") : undefined}
                      className={cn(
                        "whitespace-nowrap px-3 py-2 text-xs font-semibold text-muted-foreground",
                        column.align === "right" && "text-right",
                        column.hideBelow && HIDE[column.hideBelow],
                        column.className,
                      )}
                    >
                      {column.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(column.id)}
                          className={cn("inline-flex items-center gap-1 rounded hover:text-foreground", column.align === "right" && "flex-row-reverse")}
                        >
                          {column.header}
                          {sorted ? (
                            sort?.desc ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />
                          ) : (
                            <ArrowUpDown className="size-3 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  )
                })}
                {rowActions && (
                  <th scope="col" className="w-px px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const id = getRowId(row)
                return (
                  <tr
                    key={id}
                    onClick={
                      clickable
                        ? (event) => {
                            if (fromInteractive(event)) return
                            if (onRowClick) onRowClick(row)
                            const href = rowHref?.(row)
                            if (href) router.push(href)
                          }
                        : undefined
                    }
                    className={cn(
                      "border-b border-admin-row last:border-b-0",
                      clickable && "cursor-pointer hover:bg-admin-surface",
                      selectedId === id && "bg-admin-selected hover:bg-admin-selected",
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn("px-3 py-2 align-middle", column.align === "right" && "text-right", column.hideBelow && HIDE[column.hideBelow], column.className)}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                    {rowActions && <td className="px-2 py-1 text-right">{rowActions(row)}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 &&
          (rows.length === 0 ? (
            empty ?? <EmptyState title={`No ${noun.many} yet`} />
          ) : (
            <EmptyState title={`No ${noun.many} match`} description="Try a different search or clear the filters." />
          ))}
        {rows.length > 0 && (
          <TableFooter>
            <span>
              {visible.length === rows.length
                ? `${rows.length} ${rows.length === 1 ? noun.one : noun.many}`
                : `Showing ${visible.length} of ${rows.length} ${noun.many}`}
            </span>
          </TableFooter>
        )}
      </div>
    </div>
  )
}
