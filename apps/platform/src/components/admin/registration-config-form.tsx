"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateEventRegistrationConfig } from "@/app/admin/events/actions";
import { Event } from "@prisma/client";
import { dateToZonedValue, DEFAULT_TIMEZONE } from "@/lib/dates";

export function RegistrationConfigForm({ event }: { event: Event }) {
  const timezone = event.timezone || DEFAULT_TIMEZONE;
  const [fee, setFee] = useState(event.registrationFeeCents ? (event.registrationFeeCents / 100).toFixed(2) : "");
  const [autoPromote, setAutoPromote] = useState(event.waitlistAutoPromote);
  const isPaid = parseFloat(fee) > 0;

  return (
    <form action={updateEventRegistrationConfig.bind(null, event.id)} className="space-y-6 border border-white/10 bg-white/[0.02] p-6 rounded-lg">
      <h2 className="text-xl font-display font-black italic uppercase text-white">Registration Settings</h2>
      
      <div className="flex items-center space-x-3 p-4 border border-white/5 bg-white/5 rounded-md">
        <Switch id="registrationEnabled" name="registrationEnabled" defaultChecked={event.registrationEnabled} />
        <Label htmlFor="registrationEnabled" className="font-sans font-bold uppercase tracking-widest text-xs cursor-pointer">Enable Registration</Label>
      </div>

      <div className="space-y-4">
        <div>
          <Label htmlFor="registrationOpensAt" className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5 block">Opens At ({timezone})</Label>
          <Input 
            id="registrationOpensAt" 
            name="registrationOpensAt" 
            type="datetime-local" 
            defaultValue={dateToZonedValue(event.registrationOpensAt, timezone)} 
            className="bg-black/20 border-white/10 text-xs font-mono"
          />
        </div>
        <div>
          <Label htmlFor="registrationClosesAt" className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5 block">Closes At ({timezone})</Label>
          <Input 
            id="registrationClosesAt" 
            name="registrationClosesAt" 
            type="datetime-local" 
            defaultValue={dateToZonedValue(event.registrationClosesAt, timezone)} 
            className="bg-black/20 border-white/10 text-xs font-mono"
          />
        </div>
      </div>

      <div className="space-y-4 pt-4 border-t border-white/5">
        <div>
          <Label htmlFor="registrationMax" className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5 block">Max Capacity (Empty for unlimited)</Label>
          <Input 
            id="registrationMax" 
            name="registrationMax" 
            type="number" 
            defaultValue={event.registrationMax ?? ""} 
            placeholder="Unlimited"
            className="bg-black/20 border-white/10 text-xs font-mono"
          />
        </div>
        <div className="flex items-center space-x-3 p-4 border border-white/5 bg-white/5 rounded-md">
          <Switch id="registrationWaitlistEnabled" name="registrationWaitlistEnabled" defaultChecked={event.registrationWaitlistEnabled} />
          <Label htmlFor="registrationWaitlistEnabled" className="font-sans font-bold uppercase tracking-widest text-xs cursor-pointer">Enable Waitlist</Label>
        </div>
        <div className="p-4 border border-white/5 bg-white/5 rounded-md space-y-2">
          <div className="flex items-center space-x-3">
            <Switch
              id="waitlistAutoPromote"
              name="waitlistAutoPromote"
              checked={!isPaid && autoPromote}
              onCheckedChange={setAutoPromote}
              disabled={isPaid}
            />
            <Label htmlFor="waitlistAutoPromote" className="font-sans font-bold uppercase tracking-widest text-xs cursor-pointer">
              Automatically move people up from the waitlist when a spot opens
            </Label>
          </div>
          {/* A disabled switch isn't submitted; keep the saved setting for if the event goes free again */}
          {isPaid && autoPromote && <input type="hidden" name="waitlistAutoPromote" value="on" />}
          {isPaid && (
            <p className="text-[10px] text-white/30">Paid events: promote waitlisted people by hand, since they haven&apos;t paid yet.</p>
          )}
        </div>
      </div>

      <div className="space-y-4 pt-4 border-t border-white/5">
        <div>
          <Label htmlFor="registrationFeeCents" className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5 block">Registration Fee (USD)</Label>
          <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm">$</span>
            <Input
              id="registrationFeeCents"
              name="registrationFeeCents"
              type="number"
              min="0"
              step="0.01"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0.00 (Free)"
              className="bg-black/20 border-white/10 text-xs font-mono"
            />
          </div>
          <p className="text-[10px] text-white/30 mt-1">Leave blank for free events. Setting a fee requires Stripe payment before registration.</p>
        </div>
      </div>

      <Button type="submit" className="w-full bg-lsr-orange hover:bg-lsr-orange/90 text-white uppercase tracking-widest text-xs font-bold h-10">
        Update Configuration
      </Button>
    </form>
  );
}