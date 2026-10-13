"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Pencil } from "lucide-react"
import { unexpectedError } from "@/lib/action-result"
import {
  Badge,
  Button,
  CellStack,
  DataTable,
  EmptyState,
  Field,
  FormActions,
  IconButton,
  Input,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  RowActions,
  Segmented,
  SplitLayout,
  ToneText,
  type Column,
} from "@/components/admin/kit"
import { createCarMapping, updateCarMapping } from "@/app/admin/cars/actions"

export type CarRow = {
  /** The CarMapping id; null for a car name seen in results with no mapping yet */
  id: string | null
  gameCarName: string
  displayName: string
  secondaryDisplayName: string | null
  /** Race entries that used this car */
  entries: number
}

type View = "all" | "unmapped" | "mapped"

export function CarsConsole({ cars }: { cars: CarRow[] }) {
  const [view, setView] = useState<View>("all")
  // Keyed by game name: it's unique, and it stays the same when an unmapped car gets its mapping id
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const selected = cars.find((car) => car.gameCarName === selectedName) ?? null

  const counts = { all: cars.length, unmapped: cars.filter((c) => !c.id).length, mapped: cars.filter((c) => c.id).length }
  const visible = cars.filter((c) => (view === "all" ? true : view === "unmapped" ? !c.id : !!c.id))
  const nextUnmapped = (after?: string) => cars.find((c) => !c.id && c.gameCarName !== after)?.gameCarName ?? null

  const columns: Column<CarRow>[] = [
    {
      id: "game",
      header: "Game name",
      sortValue: (c) => c.gameCarName,
      cell: (c) => (
        <button type="button" onClick={() => setSelectedName(c.gameCarName)} className="max-w-[260px] truncate text-left font-mono text-xs hover:underline" title={c.gameCarName}>
          {c.gameCarName}
        </button>
      ),
    },
    {
      id: "display",
      header: "Shown as",
      sortValue: (c) => (c.id ? c.displayName : null),
      cell: (c) => (c.id ? <CellStack primary={c.displayName} secondary={c.secondaryDisplayName ?? undefined} /> : <ToneText tone="warning">Not mapped</ToneText>),
    },
    { id: "entries", header: "Entries", align: "right", hideBelow: "sm", sortValue: (c) => c.entries, cell: (c) => c.entries },
    {
      id: "status",
      header: "Status",
      hideBelow: "md",
      sortValue: (c) => (c.id ? 1 : 0),
      cell: (c) => (c.id ? <Badge tone="success">Mapped</Badge> : <Badge tone="warning">Unmapped</Badge>),
    },
  ]

  return (
    <SplitLayout
      main={
        <DataTable
          rows={visible}
          columns={columns}
          getRowId={(c) => c.gameCarName}
          search={{ placeholder: "Search cars", text: (c) => `${c.gameCarName} ${c.displayName} ${c.secondaryDisplayName ?? ""}` }}
          filters={
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: "all", label: "All", count: counts.all },
                { value: "unmapped", label: "Unmapped", count: counts.unmapped },
                { value: "mapped", label: "Mapped", count: counts.mapped },
              ]}
            />
          }
          // Unmapped first; within each group the server's order (by name) holds
          initialSort={{ id: "status" }}
          onRowClick={(c) => setSelectedName(c.gameCarName)}
          selectedId={selectedName ?? undefined}
          noun={{ one: "car", many: "cars" }}
          minWidth={560}
          empty={
            cars.length === 0 ? (
              <EmptyState title="No cars yet" description="Cars appear here once results that use them are ingested." />
            ) : (
              <EmptyState title={view === "unmapped" ? "Every car is mapped" : "No cars here"} />
            )
          }
          rowActions={(c) => (
            <RowActions>
              <IconButton label={c.id ? `Edit ${c.gameCarName}` : `Map ${c.gameCarName}`} onClick={() => setSelectedName(c.gameCarName)}>
                <Pencil />
              </IconButton>
            </RowActions>
          )}
        />
      }
      side={
        selected ? (
          <CarEditor
            key={selected.gameCarName}
            car={selected}
            onClose={() => setSelectedName(null)}
            onSaved={() => setSelectedName(selected.id ? null : nextUnmapped(selected.gameCarName))}
          />
        ) : (
          <Panel>
            <EmptyState
              title={counts.unmapped ? `${counts.unmapped} ${counts.unmapped === 1 ? "car needs" : "cars need"} a name` : "Every car is mapped"}
              description="Pick a car to set the name the site shows for it."
              action={
                counts.unmapped > 0 && (
                  <Button variant="primary" onClick={() => setSelectedName(nextUnmapped())}>
                    Map the first one
                  </Button>
                )
              }
            />
          </Panel>
        )
      }
    />
  )
}

function CarEditor({ car, onClose, onSaved }: { car: CarRow; onClose: () => void; onSaved: () => void }) {
  const isNew = !car.id
  // An unmapped car starts with its game name, selected so typing replaces it
  const [displayName, setDisplayName] = useState(car.displayName)
  const [secondary, setSecondary] = useState(car.secondaryDisplayName ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  // Focusing the field also scrolls the panel into view on phones, where it sits under the list
  useEffect(() => {
    nameInput.current?.focus()
    if (isNew) nameInput.current?.select()
  }, [isNew])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const name = displayName.trim()
    if (!name) {
      setError("Enter the name the site should show.")
      return
    }
    setPending(true)
    try {
      if (car.id) await updateCarMapping(car.id, name, secondary.trim() || null)
      else await createCarMapping(car.gameCarName, name, secondary.trim() || null)
      toast.success(isNew ? `Mapped ${car.gameCarName}` : `Saved ${name}`)
      onSaved()
    } catch (e) {
      console.error(e)
      toast.error(unexpectedError(e, "Couldn't save the car"))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={save}>
      <Panel>
        <PanelHeader
          title={<span className="break-all font-mono text-[13px]">{car.gameCarName}</span>}
          description={
            <span className="flex flex-wrap items-center gap-2">
              {isNew ? <Badge tone="warning">Unmapped</Badge> : <Badge tone="success">Mapped</Badge>}
              Used in {car.entries} {car.entries === 1 ? "race entry" : "race entries"}
            </span>
          }
        />
        <PanelBody className="flex flex-col gap-3">
          <Field label="Display name" htmlFor="car-display" required error={error}>
            <Input
              ref={nameInput}
              id="car-display"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value)
                setError(null)
              }}
              placeholder="Ferrari 296 GT3"
              aria-invalid={!!error}
            />
          </Field>
          <Field label="Second line" htmlFor="car-secondary" hint="Optional, shown under the name, e.g. the mod it comes from.">
            <Input id="car-secondary" value={secondary} onChange={(e) => setSecondary(e.target.value)} placeholder="RSS Formula Hybrid" />
          </Field>
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full" note={isNew ? "Saving links it to past results and moves to the next unmapped car." : undefined}>
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" pending={pending}>
              {isNew ? "Map car" : "Save"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
