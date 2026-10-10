"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { startProductCheckout } from "@/components/product-checkout-button";
import { RACING_EQUIPMENT_OPTIONS, SIM_EXPERIENCE_OPTIONS, type LeagueApplicationInput } from "@/schemas/league-application.schema";
import { submitLeagueApplication } from "@/app/lone-star-cup/enter/actions";
import { formatCents } from "@/lib/money";

export type LeagueEntryFormDefaults = {
  discordUsername: string;
  experience: LeagueApplicationInput["experience"] | null;
  equipment: LeagueApplicationInput["equipment"];
  canCommit: boolean;
  utStudent: boolean;
  eid: string;
  school: string;
  notes: string;
};

const labelClass = "font-sans font-bold text-[11px] text-white/55 uppercase tracking-[0.2em]";
// 16px text on phones so iOS doesn't zoom into the field
const inputClass =
  "h-12 rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm";
const choiceClass =
  "flex cursor-pointer items-center gap-3 border border-white/10 bg-white/[0.02] px-4 py-3.5 text-sm text-white/80 transition-colors hover:border-white/25 has-[:checked]:border-lsr-orange has-[:checked]:bg-lsr-orange/[0.06] has-[[data-state=checked]]:border-lsr-orange has-[[data-state=checked]]:bg-lsr-orange/[0.06]";

/** A numbered part of the form */
function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="relative border border-white/10 bg-white/[0.02] p-5 md:p-7">
      <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
      <h2 className="flex items-baseline gap-3 font-display font-black italic text-2xl uppercase text-white">
        <span className="text-lsr-orange">{n}</span>
        {title}
      </h2>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

export function LeagueEntryForm({
  defaults,
  priceCents,
  isUpdate,
}: {
  defaults: LeagueEntryFormDefaults;
  priceCents: number;
  isUpdate: boolean;
}) {
  const [form, setForm] = useState(defaults);
  const [loading, setLoading] = useState(false);
  const set = <K extends keyof LeagueEntryFormDefaults>(key: K, value: LeagueEntryFormDefaults[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function toggleEquipment(value: LeagueApplicationInput["equipment"][number], on: boolean) {
    set("equipment", on ? [...form.equipment, value] : form.equipment.filter((e) => e !== value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.experience) {
      toast.error("Tell us about your sim racing experience.");
      return;
    }
    if (!form.canCommit) {
      toast.error("Entry needs the weekly practice and Saturday race commitment.");
      return;
    }
    setLoading(true);
    const result = await submitLeagueApplication({ ...form, experience: form.experience });
    if (!result.ok) {
      toast.error(result.error);
      setLoading(false);
      return;
    }
    // Stay in the loading state through the redirect to Stripe.
    if (!(await startProductCheckout("LEAGUE_FEE", "lone-star-cup"))) setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Step n="1" title="About you">
        <div className="space-y-2">
          <Label htmlFor="discord" className={labelClass}>Discord username</Label>
          <Input
            id="discord"
            value={form.discordUsername}
            onChange={(e) => set("discordUsername", e.target.value)}
            placeholder="e.g. trainboi01"
            className={inputClass}
            required
          />
          <p className="font-sans text-xs text-white/50">The comp team gives you the LSC role here. That&apos;s where the track and car downloads live.</p>
        </div>

        <div className="space-y-3">
          <label htmlFor="ut-student" className={choiceClass}>
            <Checkbox id="ut-student" checked={form.utStudent} onCheckedChange={(v) => set("utStudent", !!v)} />
            <span className="font-medium">I&apos;m a UT Austin student</span>
          </label>
          {form.utStudent ? (
            <div className="space-y-2">
              <Label htmlFor="eid" className={labelClass}>UT EID (optional)</Label>
              <Input id="eid" value={form.eid} onChange={(e) => set("eid", e.target.value)} placeholder="abc123" className={inputClass} />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="school" className={labelClass}>School or affiliation (optional)</Label>
              <Input id="school" value={form.school} onChange={(e) => set("school", e.target.value)} placeholder="Texas A&M, high school, alumni…" className={inputClass} />
            </div>
          )}
        </div>
      </Step>

      <Step n="2" title="Your racing">
        <fieldset className="space-y-3">
          <legend className={`${labelClass} mb-3`}>Sim racing experience</legend>
          {SIM_EXPERIENCE_OPTIONS.map((o) => (
            <label key={o.value} className={choiceClass}>
              <input
                type="radio"
                name="experience"
                value={o.value}
                checked={form.experience === o.value}
                onChange={() => set("experience", o.value)}
                className="accent-lsr-orange"
              />
              {o.label}
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className={`${labelClass} mb-3`}>What do you race with?</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {RACING_EQUIPMENT_OPTIONS.map((o) => (
              <label key={o.value} htmlFor={`equipment-${o.value}`} className={choiceClass}>
                <Checkbox
                  id={`equipment-${o.value}`}
                  checked={form.equipment.includes(o.value)}
                  onCheckedChange={(v) => toggleEquipment(o.value, !!v)}
                />
                <span className="font-medium">{o.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Step>

      <Step n="3" title="The commitment">
        <label htmlFor="commit" className={`${choiceClass} items-start`}>
          <Checkbox id="commit" checked={form.canCommit} onCheckedChange={(v) => set("canCommit", !!v)} className="mt-0.5" />
          <span className="font-medium leading-relaxed">
            I can commit about an hour on weekdays for practice and a little over an hour on Saturdays for the races.
          </span>
        </label>

        <div className="space-y-2">
          <Label htmlFor="notes" className={labelClass}>Questions or anything we should know (optional)</Label>
          <Textarea
            id="notes"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            className="rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm"
          />
        </div>
      </Step>

      <Button
        type="submit"
        disabled={loading}
        className="mt-4 h-14 w-full rounded-none bg-lsr-orange font-sans text-xs font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"
      >
        {loading ? "Starting checkout..." : `${isUpdate ? "Save and pay" : "Continue to payment"} — ${formatCents(priceCents)}`}
      </Button>
    </form>
  );
}
