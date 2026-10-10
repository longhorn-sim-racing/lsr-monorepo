"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Download, Flag, Pencil, Plus, Search, Ticket, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { RacingNumber } from "@/components/racing-number";
import { cn } from "@/lib/utils";
import type { EntrantRow } from "@/server/queries/league-entrants";
import {
  RACING_EQUIPMENT_OPTIONS,
  SIM_EXPERIENCE_OPTIONS,
  equipmentLabel,
  experienceLabel,
} from "@/schemas/league-application.schema";
import {
  grantEntrantEntry,
  revokeEntrantEntry,
  saveEntrantApplication,
  searchEntrantUsers,
} from "@/app/admin/league-entries/actions";
import { formatCents } from "@/lib/money";

type SeasonOption = { id: string; slug: string; name: string };
type StatusFilter = "all" | "paid" | "manual" | "awaiting" | "ended";

const STATUS_BADGE: Record<EntrantRow["status"], { label: string; className: string }> = {
  paid: { label: "Paid", className: "border-green-500/30 bg-green-500/10 text-green-400" },
  manual: { label: "Entered (manual)", className: "border-sky-500/30 bg-sky-500/10 text-sky-300" },
  ended: { label: "Ended", className: "border-white/10 bg-white/5 text-white/40" },
  none: { label: "Awaiting payment", className: "border-amber-500/30 bg-amber-500/10 text-amber-300" },
};

const fieldClass =
  "w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors";

export function LeagueEntriesConsole({
  seasons,
  season,
  isOpenSeason,
  rows,
}: {
  seasons: SeasonOption[];
  season: SeasonOption;
  isOpenSeason: boolean;
  rows: EntrantRow[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [editing, setEditing] = useState<EntrantRow | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  const counts = useMemo(
    () => ({
      forms: rows.filter((r) => r.application).length,
      paid: rows.filter((r) => r.status === "paid").length,
      manual: rows.filter((r) => r.status === "manual").length,
      awaiting: rows.filter((r) => r.application && r.status === "none").length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "awaiting" ? !(r.application && r.status === "none") : filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      return [r.displayName, r.handle, r.email, r.eid, r.application?.discordUsername, r.application?.school]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, search, filter]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-6rem)] border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10">
          <Flag size={14} className="text-lsr-orange" />
          <span className="font-bold text-white/80 tracking-wider uppercase">LSC Entrants</span>
        </div>

        <select
          value={season.slug}
          onChange={(e) => router.push(`/admin/league-entries?season=${e.target.value}`)}
          className="bg-black/50 border border-white/10 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange"
        >
          {seasons.map((s) => (
            <option key={s.id} value={s.slug}>{s.name}</option>
          ))}
        </select>

        <div className="flex items-center gap-2 relative flex-1 min-w-48 max-w-md">
          <Search size={14} className="absolute left-3 text-white/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, EID, Discord..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 border-white/10 text-xs uppercase tracking-wider">
            <a href={`/admin/league-entries/export?season=${season.slug}`}>
              <Download size={14} className="mr-1.5" /> CSV
            </a>
          </Button>
          <Button size="sm" onClick={() => setEditing("new")} className="h-8 bg-lsr-orange text-white text-xs uppercase tracking-wider hover:bg-white hover:text-lsr-charcoal">
            <Plus size={14} className="mr-1.5" /> Add entrant
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 p-3 border-b border-white/10">
        {([
          ["all", `All ${rows.length}`],
          ["paid", `Paid ${counts.paid}`],
          ["manual", `Manual ${counts.manual}`],
          ["awaiting", `Awaiting payment ${counts.awaiting}`],
          ["ended", "Ended"],
        ] as [StatusFilter, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "rounded border px-3 py-1 text-[11px] uppercase tracking-wider transition-colors",
              filter === key ? "border-lsr-orange bg-lsr-orange/10 text-lsr-orange" : "border-white/10 text-white/50 hover:text-white"
            )}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto self-center text-[11px] text-white/40">
          {counts.forms} entry forms{!isOpenSeason && " · past season: manual entry is off"}
        </span>
      </div>

      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-white/40">
            <tr>
              <th className="px-3 py-2">Driver</th>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Discord</th>
              <th className="px-3 py-2">School / EID</th>
              <th className="px-3 py-2">Experience</th>
              <th className="px-3 py-2">Equipment</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Form</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {visible.map((r) => (
              <tr key={r.userId} className="align-top hover:bg-white/[0.03]">
                <td className="px-3 py-2">
                  <Link href={`/drivers/${r.handle}`} className="font-bold text-white hover:text-lsr-orange">{r.displayName}</Link>
                  <div className="text-white/40">{r.email}</div>
                  {r.application?.notes && <div className="mt-1 max-w-xs whitespace-pre-wrap text-white/60">“{r.application.notes}”</div>}
                  {r.entryNote && <div className="mt-1 text-sky-300/70">Entry note: {r.entryNote}</div>}
                </td>
                <td className="px-3 py-2"><RacingNumber user={r.racing} size="xs" fallback={<span className="text-white/20">—</span>} /></td>
                <td className="px-3 py-2 text-white/80">{r.application?.discordUsername ?? <span className="text-white/20">—</span>}</td>
                <td className="px-3 py-2 text-white/60">
                  {r.application ? r.application.school ?? "UT Austin" : ""}
                  {r.eid && <div className="text-white/40">{r.eid}</div>}
                </td>
                <td className="px-3 py-2 text-white/60">{r.application ? experienceLabel(r.application.experience) : ""}</td>
                <td className="px-3 py-2 text-white/60">
                  {r.application?.equipment.map(equipmentLabel).join(", ")}
                  {r.application && !r.application.canCommit && <div className="text-amber-300/80">Can&apos;t commit to schedule</div>}
                </td>
                <td className="px-3 py-2">
                  <span className={cn("inline-block rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider", STATUS_BADGE[r.status].className)}>
                    {r.status === "none" && !r.application ? "No entry" : STATUS_BADGE[r.status].label}
                  </span>
                  {r.status === "paid" && r.paidCents !== null && (
                    <div className="mt-1 text-white/40">{formatCents(r.paidCents)}{r.returningRate && " · returning"}</div>
                  )}
                  {r.paidAt && r.status !== "none" && <div className="text-white/30">{new Date(r.paidAt).toLocaleDateString()}</div>}
                </td>
                <td className="px-3 py-2 text-white/40">
                  {r.application ? (
                    <>
                      {new Date(r.application.createdAt).toLocaleDateString()}
                      <div className="lowercase">{r.application.source.replace("_", " ")}</div>
                    </>
                  ) : "none"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-white/60 hover:text-white" onClick={() => setEditing(r)} title="Edit entry form">
                      <Pencil size={13} />
                    </Button>
                    {isOpenSeason && (r.status === "none" || r.status === "ended") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        className="h-7 px-2 text-sky-300/80 hover:text-sky-300"
                        title="Enter manually (paid outside Stripe)"
                        onClick={() => {
                          const note = prompt(`Enter ${r.displayName} without a Stripe payment? Optional note (e.g. "paid cash"):`);
                          if (note !== null) run(() => grantEntrantEntry(r.userId, season.id, note), "Driver entered");
                        }}
                      >
                        <Ticket size={13} />
                      </Button>
                    )}
                    {r.status === "manual" && r.entryId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        className="h-7 px-2 text-red-400/70 hover:text-red-400"
                        title="End manual entry"
                        onClick={() => {
                          if (confirm(`End ${r.displayName}'s manual entry?`)) run(() => revokeEntrantEntry(r.entryId!), "Entry ended");
                        }}
                      >
                        <XCircle size={13} />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center text-white/30 uppercase tracking-widest">No entrants</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <EntrantDialog
        key={editing === "new" ? "new" : editing?.userId ?? "closed"}
        entrant={editing}
        season={season}
        canGrant={isOpenSeason}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

type FoundUser = Awaited<ReturnType<typeof searchEntrantUsers>>[number];

function EntrantDialog({
  entrant,
  season,
  canGrant,
  onClose,
  onSaved,
}: {
  entrant: EntrantRow | "new" | null;
  season: SeasonOption;
  canGrant: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = entrant && entrant !== "new" ? entrant : null;
  const app = existing?.application;
  const [user, setUser] = useState<{ id: string; displayName: string; email: string; eid: string | null } | null>(
    existing ? { id: existing.userId, displayName: existing.displayName, email: existing.email, eid: existing.eid } : null
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundUser[]>([]);
  const [form, setForm] = useState({
    discordUsername: app?.discordUsername ?? "",
    experience: app?.experience ?? "SIM_RACER",
    equipment: app?.equipment ?? ["WHEEL", "PEDALS"],
    canCommit: app?.canCommit ?? true,
    utStudent: app ? app.school === null : true,
    eid: existing?.eid ?? "",
    school: app?.school ?? "",
    notes: app?.notes ?? "",
  });
  const [alsoEnter, setAlsoEnter] = useState(false);
  const [entryNote, setEntryNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function lookup(q: string) {
    setQuery(q);
    setResults(q.trim().length >= 2 ? await searchEntrantUsers(q) : []);
  }

  async function save() {
    if (!user) return toast.error("Pick a driver first.");
    setSaving(true);
    const result = await saveEntrantApplication(user.id, season.id, form);
    if (result.ok && alsoEnter) {
      const granted = await grantEntrantEntry(user.id, season.id, entryNote);
      if (!granted.ok) toast.error(`Form saved, but entry failed: ${granted.error}`);
    }
    setSaving(false);
    if (!result.ok) return toast.error(result.error);
    toast.success("Entry form saved");
    onSaved();
  }

  const toggleEquipment = (value: string, on: boolean) =>
    setForm((f) => ({ ...f, equipment: on ? [...f.equipment, value] : f.equipment.filter((e) => e !== value) }));

  return (
    <Dialog open={entrant !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-white/10 bg-lsr-charcoal font-mono text-sm sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white">{existing ? `Entry form: ${existing.displayName}` : "Add entrant"} · {season.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!existing && (
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wider text-white/40">Driver (must have a site account)</label>
              {user ? (
                <div className="flex items-center justify-between rounded border border-white/10 bg-black/40 px-3 py-2 text-xs">
                  <span className="text-white">{user.displayName} <span className="text-white/40">{user.email}</span></span>
                  <button className="text-white/40 hover:text-white" onClick={() => setUser(null)}>change</button>
                </div>
              ) : (
                <>
                  <input value={query} onChange={(e) => lookup(e.target.value)} placeholder="Search name, email, handle or EID" className={fieldClass} autoFocus />
                  {results.length > 0 && (
                    <div className="max-h-48 overflow-y-auto rounded border border-white/10">
                      {results.map((u) => (
                        <button
                          key={u.id}
                          className="block w-full px-3 py-2 text-left text-xs text-white/80 hover:bg-white/5"
                          onClick={() => {
                            setUser(u);
                            setForm((f) => ({ ...f, eid: u.eid ?? f.eid }));
                          }}
                        >
                          {u.displayName} <span className="text-white/40">{u.email}{u.eid ? ` · ${u.eid}` : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-white/40">Discord username</label>
            <input value={form.discordUsername} onChange={(e) => setForm({ ...form, discordUsername: e.target.value })} className={fieldClass} />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="admin-ut" checked={form.utStudent} onCheckedChange={(v) => setForm({ ...form, utStudent: !!v })} />
            <label htmlFor="admin-ut" className="text-xs text-white/80">UT Austin student</label>
          </div>
          {form.utStudent ? (
            <input value={form.eid} onChange={(e) => setForm({ ...form, eid: e.target.value })} placeholder="UT EID (optional)" className={fieldClass} />
          ) : (
            <input value={form.school} onChange={(e) => setForm({ ...form, school: e.target.value })} placeholder="School or affiliation (optional)" className={fieldClass} />
          )}

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-white/40">Experience</label>
            <select value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} className={fieldClass}>
              {SIM_EXPERIENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {RACING_EQUIPMENT_OPTIONS.map((o) => (
              <div key={o.value} className="flex items-center gap-2">
                <Checkbox id={`admin-eq-${o.value}`} checked={form.equipment.includes(o.value)} onCheckedChange={(v) => toggleEquipment(o.value, !!v)} />
                <label htmlFor={`admin-eq-${o.value}`} className="text-xs text-white/80">{o.label}</label>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="admin-commit" checked={form.canCommit} onCheckedChange={(v) => setForm({ ...form, canCommit: !!v })} />
            <label htmlFor="admin-commit" className="text-xs text-white/80">Can commit to weekday practice and Saturday races</label>
          </div>

          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes / questions (optional)" rows={2} className={fieldClass} />

          {canGrant && (!existing || existing.status === "none" || existing.status === "ended") && (
            <div className="space-y-2 rounded border border-sky-500/20 bg-sky-500/5 p-3">
              <div className="flex items-center gap-2">
                <Checkbox id="admin-enter" checked={alsoEnter} onCheckedChange={(v) => setAlsoEnter(!!v)} />
                <label htmlFor="admin-enter" className="text-xs text-sky-200">Also enter them now (paid outside Stripe or comped)</label>
              </div>
              {alsoEnter && (
                <input value={entryNote} onChange={(e) => setEntryNote(e.target.value)} placeholder='Note, e.g. "paid Venmo 9/20"' className={fieldClass} />
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-white/60">Cancel</Button>
            <Button size="sm" disabled={saving || !user} onClick={save} className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal">
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
