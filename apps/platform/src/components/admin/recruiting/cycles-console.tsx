"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  CheckboxField,
  Dialog,
  EmptyState,
  Field,
  FieldGrid,
  Input,
  Notice,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  RowActions,
  RowMenu,
  TD,
  TH,
  THead,
  TR,
  Table,
  useConfirm,
  type Tone,
} from "@/components/admin/kit";
import {
  createCycleAction,
  deleteCycleAction,
  runSweepAction,
  saveBookingLinkAction,
  setActiveCycleAction,
  updateCycleAction,
} from "@/app/admin/recruiting/actions";
import type { CycleWindow } from "@/lib/recruiting/cycle";
import { formatCentral } from "@/lib/recruiting/labels";
import { slugify } from "@/lib/slug";

type CycleRow = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  window: CycleWindow;
  opensAt: string;
  closesAt: string;
  opensLocal: string;
  closesLocal: string;
  submitted: number;
  drafts: number;
};

function stateOf(c: CycleRow): { text: string; tone: Tone } {
  if (!c.isActive) return { text: "Not active", tone: "neutral" };
  if (c.window === "open") return { text: "Active, open", tone: "success" };
  if (c.window === "upcoming") return { text: "Active, opens later", tone: "info" };
  return { text: "Active, closed", tone: "warning" };
}

export function CyclesConsole({
  cycles,
  selectedSlug,
  links,
  interviewTeams,
}: {
  cycles: CycleRow[];
  selectedSlug: string | null;
  links: Record<string, string | null>;
  interviewTeams: Array<{ key: string; label: string }>;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<CycleRow | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const selected = cycles.find((c) => c.slug === selectedSlug) ?? null;
  const active = cycles.find((c) => c.isActive) ?? null;

  /** Confirms, runs the action, and reports the outcome. */
  async function run(key: string, options: Parameters<typeof confirm>[0], action: () => Promise<{ ok: boolean; error?: string }>, success: string | null) {
    if (!(await confirm(options))) return;
    setBusy(key);
    const res = await action();
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    if (success) toast.success(success);
    router.refresh();
  }

  function sweep(c: CycleRow) {
    return run(
      `sweep:${c.id}`,
      {
        title: `Run the deadline sweep for ${c.name}?`,
        description:
          "This submits every complete draft for its applicant (and emails them a confirmation). Incomplete drafts are left alone and never submitted. It also runs by itself every 15 minutes, and running it again changes nothing.",
        confirmLabel: "Run sweep",
      },
      async () => {
        const res = await runSweepAction(c.id);
        if (res.ok) {
          const d = res.data;
          const unsent = d.emailsFailed + d.emailsOverLimit;
          toast.message(
            `Sweep finished: ${d.submitted} submitted, ${d.skippedIncomplete + d.skippedNoTeams} incomplete left as drafts${unsent > 0 ? `, ${unsent} confirmation email(s) not sent (see Emails)` : ""}${d.timedOut ? ". Time ran out: run it again to continue" : ""}.`,
          );
        }
        return res;
      },
      null, // the action reports its own result
    );
  }

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        back={{ href: "/admin/recruiting", label: "Applications" }}
        title="Recruiting rounds"
        description={
          <>
            Applicants can apply only to the <strong className="font-semibold text-foreground">active</strong> round, and only between its open and close times (Central time). Only one round is active at a time.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus /> New round
          </Button>
        }
      />

      {active === null && <Notice tone="warning">No round is active, so applications are closed.</Notice>}

      {cycles.length === 0 ? (
        <Panel>
          <EmptyState title="No rounds yet" description="Create a round to set when applications open and close." />
        </Panel>
      ) : (
        <Table minWidth={820}>
          <THead>
            <TH>Round</TH>
            <TH>Opens</TH>
            <TH>Closes</TH>
            <TH>State</TH>
            <TH>Applications</TH>
            <TH className="text-right">
              <span className="sr-only">Actions</span>
            </TH>
          </THead>
          <tbody>
            {cycles.map((c) => {
              const state = stateOf(c);
              return (
                <TR key={c.id} selected={c.slug === selectedSlug} className="align-top">
                  <TD>
                    <Link href={`/admin/recruiting?cycle=${c.slug}`} className="font-semibold hover:text-primary hover:underline">
                      {c.name}
                    </Link>
                    <div className="text-xs text-admin-subtle">{c.slug}</div>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatCentral(c.opensAt)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatCentral(c.closesAt)}</TD>
                  <TD>
                    <Badge tone={state.tone}>{state.text}</Badge>
                  </TD>
                  <TD className="text-muted-foreground">
                    {c.submitted} submitted
                    {c.drafts > 0 && (
                      <div className="text-xs text-admin-subtle">
                        {c.drafts} draft{c.drafts === 1 ? "" : "s"}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <RowActions className="flex-wrap gap-1.5">
                      {c.window === "closed" && c.drafts > 0 && (
                        <Button size="sm" pending={busy === `sweep:${c.id}`} onClick={() => void sweep(c)}>
                          Run sweep now
                        </Button>
                      )}
                      {c.isActive ? (
                        <Button
                          size="sm"
                          pending={busy === `off:${c.id}`}
                          onClick={() =>
                            void run(
                              `off:${c.id}`,
                              {
                                title: `Turn off ${c.name}?`,
                                description: "Applicants will no longer be able to start, save or submit an application. Applications already submitted stay as they are.",
                                confirmLabel: "Turn off",
                              },
                              () => setActiveCycleAction(null),
                              "Recruiting is off.",
                            )
                          }
                        >
                          Turn off
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          pending={busy === `on:${c.id}`}
                          onClick={() =>
                            void run(
                              `on:${c.id}`,
                              {
                                title: `Make ${c.name} the active round?`,
                                description: `Applicants will apply to this round between its open and close times.${active ? ` ${active.name} will be turned off.` : ""}`,
                                confirmLabel: "Make active",
                              },
                              () => setActiveCycleAction(c.id),
                              `${c.name} is now the active round.`,
                            )
                          }
                        >
                          Make active
                        </Button>
                      )}
                      <RowMenu
                        label={`Actions for ${c.name}`}
                        items={[
                          { label: "Edit name and dates", onSelect: () => setEditing(c) },
                          { label: "Booking links", href: `/admin/recruiting/cycles?cycle=${c.slug}` },
                          ...(!c.isActive && c.submitted + c.drafts === 0
                            ? [
                                "separator" as const,
                                {
                                  label: "Delete round",
                                  destructive: { title: `Delete ${c.name}?`, description: "This round has no applications. Deleting it can't be undone.", confirmLabel: "Delete" },
                                  onSelect: async () => {
                                    const res = await deleteCycleAction(c.id);
                                    if (!res.ok) return void toast.error(res.error);
                                    toast.success("Round deleted.");
                                    router.refresh();
                                  },
                                },
                              ]
                            : []),
                        ]}
                      />
                    </RowActions>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      )}

      {selected && <BookingLinks key={selected.id} cycle={selected} links={links} teams={interviewTeams} />}

      <RoundDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function RoundDialog({ editing, onClose, onSaved }: { editing: CycleRow | "new" | null; onClose: () => void; onSaved: () => void }) {
  const existing = editing && editing !== "new" ? editing : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(false);
  const [opensAt, setOpensAt] = useState(existing?.opensLocal ?? "");
  const [closesAt, setClosesAt] = useState(existing?.closesLocal ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      if (existing) {
        const res = await updateCycleAction(existing.id, { name, opensAt, closesAt });
        if (!res.ok) {
          setError(res.error);
          setFieldErrors(res.fieldErrors ?? {});
          return;
        }
        toast.success("Round updated.");
        return onSaved();
      }
      const res = await createCycleAction({ name, slug, opensAt, closesAt });
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        return;
      }
      const copied = res.data.copiedLinks;
      toast.success(
        copied > 0
          ? `Round created. Copied ${copied} booking link${copied === 1 ? "" : "s"} from the previous round; check they still have open slots.`
          : "Round created. Make it active when you are ready.",
      );
      onSaved();
    });
  }

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => !open && !pending && onClose()}
      title={existing ? "Edit round" : "New round"}
      description="Times are Central time (CT)."
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" pending={pending} onClick={save}>
            {existing ? "Save changes" : "Create round"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" htmlFor="round-name" error={fieldErrors.name}>
          <Input
            id="round-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!existing && !slugTouched) setSlug(slugify(e.target.value).replace(/_/g, "-"));
            }}
            maxLength={80}
            placeholder="Fall 2026"
          />
        </Field>
        <Field
          label="Address (used in links and file names)"
          htmlFor="round-slug"
          error={fieldErrors.slug}
          hint={existing ? "The address can't be changed after the round is created." : undefined}
        >
          <Input
            id="round-slug"
            value={slug}
            disabled={Boolean(existing)}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            maxLength={40}
            placeholder="fall-2026"
          />
        </Field>
        <FieldGrid>
          <Field label="Opens" htmlFor="round-opens" error={fieldErrors.opensAt}>
            <Input id="round-opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          </Field>
          <Field label="Closes (the deadline)" htmlFor="round-closes" error={fieldErrors.closesAt}>
            <Input id="round-closes" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </Field>
        </FieldGrid>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/** Each interviewing team's Google Calendar booking link for the selected round. */
function BookingLinks({ cycle, links, teams }: { cycle: CycleRow; links: Record<string, string | null>; teams: Array<{ key: string; label: string }> }) {
  return (
    <Panel>
      <PanelHeader
        title={`Interview booking links: ${cycle.name}`}
        description="Each team that interviews makes a booking page in Google Calendar (appointment scheduling) and pastes its link here. It goes into that team's interview invitation and shows as a button on the applicant's status page. Leave it empty and the invitation asks the applicant to reply to schedule."
      />
      <PanelBody>
        {teams.length === 0 ? (
          <p className="text-xs text-admin-subtle">No team runs interviews.</p>
        ) : (
          <div className="space-y-4">
            {teams.map((t) => (
              <LinkRow key={t.key} cycleId={cycle.id} team={t} initial={links[t.key] ?? ""} />
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function LinkRow({ cycleId, team, initial }: { cycleId: string; team: { key: string; label: string }; initial: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initial);
  const [allowOther, setAllowOther] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = `link-${team.key}`;

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveBookingLinkAction(cycleId, team.key, url, allowOther);
      if (!res.ok) return setError(res.error);
      toast.success(url.trim() ? `${team.label}: booking link saved.` : `${team.label}: booking link removed.`);
      router.refresh();
    });
  }

  return (
    <Field label={team.label} htmlFor={id} error={error}>
      <div className="flex flex-wrap gap-2">
        <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.app.google/..." maxLength={2000} className="min-w-64 flex-1" />
        <Button pending={pending} disabled={url.trim() === initial} onClick={save}>
          Save
        </Button>
      </div>
      <CheckboxField checked={allowOther} onChange={(e) => setAllowOther(e.target.checked)} label="This isn't a Google Calendar link; use it anyway" className="mt-1" />
    </Field>
  );
}
