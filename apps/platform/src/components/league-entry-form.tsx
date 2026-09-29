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

const labelClass = "font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em]";
const inputClass = "rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange placeholder:text-white/20";

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
    <form onSubmit={handleSubmit} className="space-y-8">
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
        <p className="font-sans text-xs text-white/40">The comp team gives you the LSC role here. That&apos;s where the track and car downloads live.</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox id="ut-student" checked={form.utStudent} onCheckedChange={(v) => set("utStudent", !!v)} />
          <Label htmlFor="ut-student" className="cursor-pointer text-sm font-medium text-white/80">I&apos;m a UT Austin student</Label>
        </div>
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

      <fieldset className="space-y-3">
        <legend className={`${labelClass} mb-3`}>Sim racing experience</legend>
        {SIM_EXPERIENCE_OPTIONS.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-3 border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/80 transition-colors has-[:checked]:border-lsr-orange">
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
        <div className="grid grid-cols-2 gap-3">
          {RACING_EQUIPMENT_OPTIONS.map((o) => (
            <div key={o.value} className="flex items-center gap-2 border border-white/10 bg-black/20 px-4 py-3">
              <Checkbox
                id={`equipment-${o.value}`}
                checked={form.equipment.includes(o.value)}
                onCheckedChange={(v) => toggleEquipment(o.value, !!v)}
              />
              <Label htmlFor={`equipment-${o.value}`} className="cursor-pointer text-sm font-medium text-white/80">{o.label}</Label>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="flex items-start gap-3 border border-white/10 bg-black/20 p-4">
        <Checkbox id="commit" checked={form.canCommit} onCheckedChange={(v) => set("canCommit", !!v)} className="mt-0.5" />
        <Label htmlFor="commit" className="cursor-pointer text-sm font-medium leading-relaxed text-white/80">
          I can commit about an hour on weekdays for practice and a little over an hour on Saturdays for the races.
        </Label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes" className={labelClass}>Questions or anything we should know (optional)</Label>
        <Textarea
          id="notes"
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={3}
          className="rounded-none border-white/10 bg-white/5 text-white placeholder:text-white/20"
        />
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="h-12 w-full rounded-none bg-lsr-orange font-sans text-xs font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"
      >
        {loading ? "Starting checkout..." : `${isUpdate ? "Save and pay" : "Continue to payment"} — $${(priceCents / 100).toFixed(2)}`}
      </Button>
    </form>
  );
}
