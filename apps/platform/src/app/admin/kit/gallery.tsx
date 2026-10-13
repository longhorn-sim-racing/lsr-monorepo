"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Eye, Pencil } from "lucide-react"
import {
  Badge,
  Button,
  CellStack,
  CheckboxField,
  DataTable,
  DetailList,
  Dialog,
  EmptyState,
  Field,
  FieldGrid,
  FilterMenu,
  FormActions,
  FormSection,
  IconButton,
  Input,
  JsonView,
  MoneyInput,
  Notice,
  PageHeader,
  Pager,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  RowActions,
  RowMenu,
  Segmented,
  Select,
  SplitLayout,
  Stat,
  StatRow,
  SwitchField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ToneText,
  UserPicker,
  usePrompt,
  type AdminUserOption,
  type Column,
  type Tone,
} from "@/components/admin/kit"

type SampleEvent = { id: string; title: string; series: string; date: string; status: "Draft" | "Published" | "Completed"; registered: number; capacity: number; results: "Missing" | "Not yet" | "None needed" }

const EVENTS: SampleEvent[] = [
  { id: "gm1", title: "General Meeting 1", series: "General meetings", date: "2026-10-19", status: "Draft", registered: 0, capacity: 60, results: "Not yet" },
  { id: "r5", title: "LSC S3 · Round 5 · Long Beach", series: "Lone Star Cup", date: "2026-10-17", status: "Published", registered: 6, capacity: 30, results: "Not yet" },
  { id: "r4", title: "LSC S3 · Round 4 · Okayama", series: "Lone Star Cup", date: "2026-10-10", status: "Completed", registered: 9, capacity: 30, results: "Missing" },
  { id: "sim", title: "Open sim night", series: "Social", date: "2026-10-01", status: "Completed", registered: 18, capacity: 24, results: "None needed" },
]

const STATUS_TONE: Record<SampleEvent["status"], Tone> = { Draft: "neutral", Published: "success", Completed: "neutral" }

const columns: Column<SampleEvent>[] = [
  {
    id: "title",
    header: "Event",
    sortValue: (e) => e.title,
    cell: (e) => <CellStack primary={<Link href="#" className="hover:underline">{e.title}</Link>} secondary={e.series} />,
  },
  { id: "date", header: "Date", sortValue: (e) => e.date, cell: (e) => e.date, className: "whitespace-nowrap" },
  { id: "status", header: "Status", cell: (e) => <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge> },
  { id: "registered", header: "Registered", align: "right", hideBelow: "md", sortValue: (e) => e.registered, cell: (e) => `${e.registered} / ${e.capacity}` },
  { id: "results", header: "Results", hideBelow: "sm", cell: (e) => <ToneText tone={e.results === "Missing" ? "warning" : "neutral"}>{e.results}</ToneText> },
]

/** A live reference of every kit component, in the admin theme. Not linked from the sidebar. */
export function KitGallery() {
  const [view, setView] = useState<"all" | "upcoming" | "past">("all")
  const [statuses, setStatuses] = useState<SampleEvent["status"][]>([])
  const [selected, setSelected] = useState("gm1")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [member, setMember] = useState<AdminUserOption | null>(null)
  const prompt = usePrompt()

  const rows = EVENTS.filter((e) => (view === "all" ? true : view === "upcoming" ? e.date >= "2026-10-13" : e.date < "2026-10-13")).filter(
    (e) => statuses.length === 0 || statuses.includes(e.status),
  )

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Admin kit"
        description="Every shared admin component, with sample data. Build pages from these."
        actions={
          <>
            <Button>Export CSV</Button>
            <Button variant="primary">New event</Button>
          </>
        }
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Stats</h2>
        <StatRow className="mb-0">
          <Stat label="Applications" value="13" hint="12 by form, 1 on the site" />
          <Stat label="Paid entries" value="0" />
          <Stat label="Rounds missing results" value="4" />
        </StatRow>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">List with a side panel</h2>
        <SplitLayout
          main={
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(e) => e.id}
              search={{ placeholder: "Search events", text: (e) => `${e.title} ${e.series}` }}
              filters={
                <>
                  <Segmented
                    label="Show"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "all", label: "All", count: EVENTS.length },
                      { value: "upcoming", label: "Upcoming" },
                      { value: "past", label: "Past" },
                    ]}
                  />
                  <FilterMenu
                    label="Status"
                    selected={statuses}
                    onChange={setStatuses}
                    options={[
                      { value: "Draft", label: "Draft" },
                      { value: "Published", label: "Published" },
                      { value: "Completed", label: "Completed" },
                    ]}
                  />
                </>
              }
              onRowClick={(e) => setSelected(e.id)}
              selectedId={selected}
              initialSort={{ id: "date", desc: true }}
              noun={{ one: "event", many: "events" }}
              rowActions={(e) => (
                <RowActions>
                  <IconButton label={`View ${e.title}`}>
                    <Eye />
                  </IconButton>
                  <IconButton label={`Edit ${e.title}`} onClick={() => setSelected(e.id)}>
                    <Pencil />
                  </IconButton>
                  <RowMenu
                    label={`More actions for ${e.title}`}
                    items={[
                      { label: "Open public page", href: "/events", external: true },
                      { label: "Duplicate", onSelect: () => toast.success("Duplicated (demo)") },
                      "separator",
                      {
                        label: "Delete",
                        destructive: { title: `Delete ${e.title}?`, description: "Registrations and attendance for it are deleted too. This can't be undone." },
                        onSelect: () => toast.success("Deleted (demo)"),
                      },
                    ]}
                  />
                </RowActions>
              )}
            />
          }
          side={
            <Panel>
              <PanelHeader title="General Meeting 1" description={<span className="flex items-center gap-2"><Badge>Draft</Badge>Hidden from the public calendar</span>} />
              <PanelBody className="flex flex-col gap-5">
                <FormSection title="Basics">
                  <Field label="Title" htmlFor="kit-title" required>
                    <Input id="kit-title" defaultValue="General Meeting 1" />
                  </Field>
                  <FieldGrid>
                    <Field label="Series" htmlFor="kit-series">
                      <Select id="kit-series" defaultValue="gm">
                        <option value="gm">General meetings</option>
                        <option value="lsc">Lone Star Cup</option>
                      </Select>
                    </Field>
                    <Field label="Fee" htmlFor="kit-fee" hint="Blank means free">
                      <MoneyInput id="kit-fee" placeholder="0.00" />
                    </Field>
                  </FieldGrid>
                  <Field label="Summary" htmlFor="kit-summary" error="Keep it under 160 characters.">
                    <Textarea id="kit-summary" rows={2} defaultValue="Our first general meeting of the year." aria-invalid />
                  </Field>
                </FormSection>
                <FormSection title="Registration">
                  <SwitchField label="Take registrations" description="Members sign up on the event page." defaultChecked />
                  <CheckboxField label="Waitlist when full" description="Promotes people in order as spots open." />
                </FormSection>
                <Field label="Member" htmlFor="kit-member" hint="Searches name, handle, email or EID">
                  <UserPicker id="kit-member" value={member} onChange={setMember} />
                </Field>
              </PanelBody>
              <PanelFooter>
                <FormActions note="Drafted by Jack for Dylan · 2 min ago" className="w-full">
                  <Button>Save draft</Button>
                  <Button variant="primary">Publish</Button>
                </FormActions>
              </PanelFooter>
            </Panel>
          }
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Buttons, badges and notices</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="danger-solid">Delete for good</Button>
          <Button pending>Saving</Button>
          <Button size="sm">Small</Button>
          <Button onClick={() => setDialogOpen(true)}>Open a dialog</Button>
          <Button
            onClick={async () => {
              const note = await prompt({ title: "Grant entry", inputLabel: "Note for the audit log", required: true, confirmLabel: "Grant" })
              if (note) toast.success(`Granted: ${note}`)
            }}
          >
            Ask for a note
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["neutral", "success", "warning", "danger", "info", "accent"] as const).map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <Notice tone="warning" title="This product is live">Price changes apply to the next checkout.</Notice>
          <Notice tone="danger" title="Sync failed" action={<Button size="sm">Retry</Button>}>Instagram returned an expired token.</Notice>
          <Notice tone="success" title="Results ingested">18 drivers, 2 sessions.</Notice>
          <Notice tone="info">Times are Central (America/Chicago).</Notice>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Tabs, details and empty states</h2>
        <Panel>
          <PanelBody>
            <Tabs defaultValue="details">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="json">Raw</TabsTrigger>
                <TabsTrigger value="empty">Empty</TabsTrigger>
              </TabsList>
              <TabsContent value="details">
                <DetailList
                  items={[
                    { label: "Action", value: "event.update" },
                    { label: "By", value: "Dylan" },
                    { label: "When", value: "Oct 12, 10:43 PM" },
                  ]}
                />
              </TabsContent>
              <TabsContent value="json">
                <JsonView value={{ status: { before: "DRAFT", after: "PUBLISHED" }, registrationMax: 60 }} />
              </TabsContent>
              <TabsContent value="empty">
                <EmptyState title="No results uploaded" description="Upload a race JSON from the sim to add one." action={<Button variant="primary">Upload results</Button>} />
              </TabsContent>
            </Tabs>
          </PanelBody>
          <Pager page={2} pageCount={7} hrefFor={(p) => `?page=${p}`} summary="51–100 of 312" />
        </Panel>
      </section>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Override status"
        description="Overrides the automatic status until you clear it."
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setDialogOpen(false)}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Status" htmlFor="kit-override">
          <Select id="kit-override">
            <option>Scheduled</option>
            <option>In progress</option>
            <option>Cancelled</option>
          </Select>
        </Field>
      </Dialog>
    </div>
  )
}
