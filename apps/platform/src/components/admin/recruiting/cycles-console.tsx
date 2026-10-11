"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  createCycleAction,
  deleteCycleAction,
  saveBookingLinkAction,
  setActiveCycleAction,
  updateCycleAction,
} from "@/app/admin/recruiting/actions";
import type { CycleWindow } from "@/lib/recruiting/cycle";
import { formatCentral } from "@/lib/recruiting/labels";
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/utils";

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

const fieldClass =
  "w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors";
const labelClass = "mb-1 block text-[11px] uppercase tracking-wider text-white/40";

function stateOf(c: CycleRow): { text: string; className: string } {
  if (!c.isActive) return { text: "Not active", className: "border-white/10 bg-white/5 text-white/40" };
  if (c.window === "open") return { text: "Active, open", className: "border-green-500/30 bg-green-500/10 text-green-400" };
  if (c.window === "upcoming") return { text: "Active, opens later", className: "border-sky-500/30 bg-sky-500/10 text-sky-300" };
  return { text: "Active, closed", className: "border-amber-500/30 bg-amber-500/10 text-amber-300" };
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
  const [editing, setEditing] = useState<CycleRow | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => Promise<{ ok: boolean; error?: string }>; success: string } | null>(null);
  const selected = cycles.find((c) => c.slug === selectedSlug) ?? null;
  const active = cycles.find((c) => c.isActive) ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 font-mono text-sm text-white">
      <Link href="/admin/recruiting" className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-white/50 hover:text-white">
        <ArrowLeft size={14} /> Applications
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 font-display text-2xl font-black uppercase italic">
          <CalendarClock size={20} className="text-lsr-orange" /> Recruiting rounds
        </h1>
        <Button size="sm" onClick={() => setEditing("new")} className="ml-auto h-8 bg-lsr-orange text-xs uppercase tracking-wider text-white hover:bg-white hover:text-lsr-charcoal">
          <Plus size={14} className="mr-1.5" /> New round
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-white/50">
        Applicants can apply only to the <strong className="text-white/80">active</strong> round, and only between its open and close times (shown in Central time). Only one round is active at a time.
        {active === null && <span className="text-amber-300"> No round is active, so applications are closed.</span>}
      </p>

      <div className="overflow-x-auto rounded-lg border border-white/10 bg-black/40">
        <table className="w-full text-left text-xs">
          <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-white/40">
            <tr>
              <th className="px-3 py-2">Round</th>
              <th className="px-3 py-2">Opens</th>
              <th className="px-3 py-2">Closes</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Applications</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {cycles.map((c) => {
              const state = stateOf(c);
              return (
                <tr key={c.id} className={cn("align-top hover:bg-white/[0.03]", c.slug === selectedSlug && "bg-white/[0.04]")}>
                  <td className="px-3 py-2">
                    <Link href={`/admin/recruiting?cycle=${c.slug}`} className="font-bold text-white hover:text-lsr-orange">{c.name}</Link>
                    <div className="text-white/40">{c.slug}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-white/70">{formatCentral(c.opensAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-white/70">{formatCentral(c.closesAt)}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-block whitespace-nowrap rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider", state.className)}>{state.text}</span>
                  </td>
                  <td className="px-3 py-2 text-white/60">
                    {c.submitted} submitted
                    {c.drafts > 0 && <div className="text-white/40">{c.drafts} draft{c.drafts === 1 ? "" : "s"}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-white/60 hover:text-white" title="Edit name and dates" onClick={() => setEditing(c)}>
                        <Pencil size={13} />
                      </Button>
                      {c.slug !== selectedSlug && (
                        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[11px] uppercase tracking-wider text-white/60 hover:text-white">
                          <Link href={`/admin/recruiting/cycles?cycle=${c.slug}`}>Booking links</Link>
                        </Button>
                      )}
                      {c.isActive ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] uppercase tracking-wider text-amber-300/80 hover:text-amber-300"
                          onClick={() =>
                            setConfirm({
                              title: `Turn off ${c.name}?`,
                              body: "Applicants will no longer be able to start, save or submit an application. Applications already submitted stay as they are.",
                              action: () => setActiveCycleAction(null),
                              success: "Recruiting is off.",
                            })
                          }
                        >
                          Turn off
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] uppercase tracking-wider text-green-400/80 hover:text-green-400"
                          onClick={() =>
                            setConfirm({
                              title: `Make ${c.name} the active round?`,
                              body: `Applicants will apply to this round between its open and close times.${active ? ` ${active.name} will be turned off.` : ""}`,
                              action: () => setActiveCycleAction(c.id),
                              success: `${c.name} is now the active round.`,
                            })
                          }
                        >
                          Make active
                        </Button>
                      )}
                      {!c.isActive && c.submitted + c.drafts === 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] uppercase tracking-wider text-red-400/70 hover:text-red-400"
                          onClick={() =>
                            setConfirm({
                              title: `Delete ${c.name}?`,
                              body: "This round has no applications. Deleting it can't be undone.",
                              action: () => deleteCycleAction(c.id),
                              success: "Round deleted.",
                            })
                          }
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {cycles.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-12 text-center uppercase tracking-widest text-white/30">No rounds yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <BookingLinks key={selected.id} cycle={selected} links={links} teams={interviewTeams} />}

      <RoundDialog key={editing === "new" ? "new" : editing?.id ?? "closed"} editing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} />
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} onDone={() => { setConfirm(null); router.refresh(); }} />
    </div>
  );
}

function ConfirmDialog({
  confirm,
  onClose,
  onDone,
}: {
  confirm: { title: string; body: string; action: () => Promise<{ ok: boolean; error?: string }>; success: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={confirm !== null} onOpenChange={(open) => !open && !pending && (setError(null), onClose())}>
      <DialogContent className="max-w-md border-white/10 bg-lsr-charcoal text-white">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-black uppercase italic">{confirm?.title}</DialogTitle>
          <DialogDescription className="text-white/60">{confirm?.body}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => { setError(null); onClose(); }} className="text-white/60">Cancel</Button>
          <Button
            disabled={pending}
            className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal"
            onClick={() =>
              startTransition(async () => {
                if (!confirm) return;
                const res = await confirm.action();
                if (!res.ok) return setError(res.error ?? "That didn't work.");
                toast.success(confirm.success);
                setError(null);
                onDone();
              })
            }
          >
            {pending ? "Working..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Dialog open={editing !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-w-md border-white/10 bg-lsr-charcoal text-white">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-black uppercase italic">{existing ? "Edit round" : "New round"}</DialogTitle>
          <DialogDescription className="text-white/60">Times are Central time (CT).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" error={fieldErrors.name}>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!existing && !slugTouched) setSlug(slugify(e.target.value).replace(/_/g, "-"));
              }}
              maxLength={80}
              placeholder="Fall 2026"
              className={fieldClass}
            />
          </Field>
          <Field label="Address (used in links and file names)" error={fieldErrors.slug}>
            <input
              value={slug}
              disabled={Boolean(existing)}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              maxLength={40}
              placeholder="fall-2026"
              className={cn(fieldClass, existing && "opacity-50")}
            />
            {existing && <p className="mt-1 text-[11px] text-white/40">The address can&apos;t be changed after the round is created.</p>}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Opens" error={fieldErrors.opensAt}>
              <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Closes (the deadline)" error={fieldErrors.closesAt}>
              <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className={fieldClass} />
            </Field>
          </div>
          {error && <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={pending} onClick={onClose} className="text-white/60">Cancel</Button>
          <Button disabled={pending} onClick={save} className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal">
            {pending ? "Saving..." : existing ? "Save changes" : "Create round"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      {children}
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}

/** Each interviewing team's Google Calendar booking link for the selected round. */
function BookingLinks({ cycle, links, teams }: { cycle: CycleRow; links: Record<string, string | null>; teams: Array<{ key: string; label: string }> }) {
  return (
    <section className="rounded-lg border border-white/10 bg-black/40 p-4">
      <h2 className="mb-1 text-[11px] uppercase tracking-wider text-lsr-orange">Interview booking links: {cycle.name}</h2>
      <p className="mb-4 text-xs leading-relaxed text-white/50">
        Each team that interviews makes a booking page in Google Calendar (appointment scheduling) and pastes its link here. It goes into that team&apos;s interview invitation and shows as a button on the applicant&apos;s status page. Leave it empty and the invitation asks the applicant to reply to schedule.
      </p>
      {teams.length === 0 ? (
        <p className="text-xs text-white/40">No team runs interviews.</p>
      ) : (
        <div className="space-y-4">
          {teams.map((t) => (
            <LinkRow key={t.key} cycleId={cycle.id} team={t} initial={links[t.key] ?? ""} />
          ))}
        </div>
      )}
    </section>
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
      if (!res.ok) return setError(res.fieldErrors?.schedulingUrl ? `${res.error}` : res.error);
      toast.success(url.trim() ? `${team.label}: booking link saved.` : `${team.label}: booking link removed.`);
      router.refresh();
    });
  }

  return (
    <div>
      <label htmlFor={id} className={labelClass}>{team.label}</label>
      <div className="flex flex-wrap gap-2">
        <input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.app.google/..." maxLength={2000} className={cn(fieldClass, "min-w-64 flex-1")} />
        <Button type="button" size="sm" disabled={pending || url.trim() === initial} onClick={save} className="h-9 bg-white/10 text-xs uppercase tracking-wider hover:bg-white/20">
          {pending ? "Saving..." : "Save"}
        </Button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11px] text-white/50">
        <Checkbox checked={allowOther} onCheckedChange={(v) => setAllowOther(v === true)} />
        This isn&apos;t a Google Calendar link; use it anyway
      </label>
      {error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
    </div>
  );
}
