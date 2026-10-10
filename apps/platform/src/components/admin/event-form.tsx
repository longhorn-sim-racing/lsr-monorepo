"use client"

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createEvent, updateEvent } from "@/app/admin/events/actions";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

import { ImageUploader } from "@/components/image-uploader";
import { Event, EventSeries, Venue } from "@prisma/client";
import { useState } from "react";
import { DEFAULT_TIMEZONE, TIMEZONES, dateToZonedValue } from "@/lib/dates";
import { Tag, Clock, Info, Users, QrCode, Megaphone } from "lucide-react";
import { centsToDollarInput } from "@/lib/money";
import { useFormAction } from "./use-form-action";

export function EventForm({ event, series, venues }: { event?: Event, series: EventSeries[], venues: Venue[] }) {
  const [timezone, setTimezone] = useState<string>(event?.timezone || DEFAULT_TIMEZONE);
  const [slug, setSlug] = useState(event?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!event);
  const { onSubmit, error, pending } = useFormAction((formData) => (event ? updateEvent(event.id, formData) : createEvent(formData)));

  return (
    <div className="max-w-5xl mx-auto font-mono text-sm border border-white/10 bg-white/[0.02] p-8 md:p-12 rounded-xl shadow-2xl">
      <form
        onSubmit={onSubmit}
        // Enter would submit with the first button, "Save as Draft", and un-publish the event; use the buttons
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
        }}
        className="space-y-16"
      >
        <input type="hidden" name="timezone" value={timezone} />
        
        {/* Basic Info */}
        <section className="space-y-8">
          <div className="flex items-center gap-3 border-l-2 border-lsr-orange pl-4">
            <Tag size={16} className="text-lsr-orange/60" />
            <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Basic Information</h3>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
            <div className="space-y-2">
              <label htmlFor="title" className="text-[10px] uppercase tracking-wider text-white/60">Event Title</label>
              <Input
                id="title"
                name="title"
                defaultValue={event?.title}
                required
                onChange={(e) => {
                  if (!slugTouched) {
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                  }
                }}
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors font-bold text-base"
                placeholder="e.g. Grand Prix of Texas"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="slug" className="text-[10px] uppercase tracking-wider text-white/60">URL Slug</label>
              <Input
                id="slug"
                name="slug"
                value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
                required
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
                placeholder="e.g. grand-prix-texas-2026"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="seriesId" className="text-[10px] uppercase tracking-wider text-white/60">Series</label>
              <select
                id="seriesId"
                name="seriesId"
                defaultValue={event?.seriesId ?? ""}
                className="w-full h-8 bg-transparent border-b border-white/20 focus:border-lsr-orange text-white outline-none rounded-none cursor-pointer"
              >
                <option value="" className="bg-lsr-charcoal text-white/50">(None)</option>
                {series.map((s) => (
                  <option key={s.id} value={s.id} className="bg-lsr-charcoal">
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="venueId" className="text-[10px] uppercase tracking-wider text-white/60">Venue</label>
              <select
                id="venueId"
                name="venueId"
                defaultValue={event?.venueId ?? ""}
                className="w-full h-8 bg-transparent border-b border-white/20 focus:border-lsr-orange text-white outline-none rounded-none cursor-pointer"
              >
                <option value="" className="bg-lsr-charcoal text-white/50">(None)</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id} className="bg-lsr-charcoal">
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Time & Location */}
        <section className="space-y-8">
          <div className="flex items-center gap-3 border-l-2 border-lsr-orange pl-4">
            <Clock size={16} className="text-lsr-orange/60" />
            <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Schedule</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
            <div className="space-y-2">
              <label htmlFor="timezone-select" className="text-[10px] uppercase tracking-wider text-white/60">Timezone</label>
              <select
                id="timezone-select"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full h-8 bg-transparent border-b border-white/20 focus:border-lsr-orange text-white outline-none rounded-none cursor-pointer"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value} className="bg-lsr-charcoal">
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hidden md:block"></div> {/* Spacer */}

            <div className="space-y-2">
              <label htmlFor="startsAtUtc" className="text-[10px] uppercase tracking-wider text-white/60">Starts At</label>
              <Input 
                id="startsAtUtc" 
                name="startsAtUtc" 
                type="datetime-local" 
                key={`start-${timezone}`} 
                defaultValue={dateToZonedValue(event?.startsAtUtc, timezone)} 
                required 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="endsAtUtc" className="text-[10px] uppercase tracking-wider text-white/60">Ends At</label>
              <Input 
                id="endsAtUtc" 
                name="endsAtUtc" 
                type="datetime-local" 
                key={`end-${timezone}`}
                defaultValue={dateToZonedValue(event?.endsAtUtc, timezone)} 
                required 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
          </div>
        </section>

        {/* Content */}
        <section className="space-y-8">
          <div className="flex items-center gap-3 border-l-2 border-lsr-orange pl-4">
            <Info size={16} className="text-lsr-orange/60" />
            <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Content</h3>
          </div>

          <div className="grid grid-cols-1 gap-8">
            <div className="space-y-2">
              <label htmlFor="summary" className="text-[10px] uppercase tracking-wider text-white/60">Short Summary</label>
              <Input 
                id="summary" 
                name="summary" 
                defaultValue={event?.summary ?? ""} 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="description" className="text-[10px] uppercase tracking-wider text-white/60">Internal Description</label>
              <Input 
                id="description" 
                name="description" 
                defaultValue={event?.description ?? ""} 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
            <div className="space-y-4 pt-2">
              <label className="text-[10px] uppercase tracking-wider text-white/60 block">Hero Image</label>
              <div className="border border-white/5 bg-black/40 p-6">
                <ImageUploader name="heroImageUrl" defaultValue={event?.heroImageUrl} />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="streamUrl" className="text-[10px] uppercase tracking-wider text-white/60">Stream URL</label>
              <Input
                id="streamUrl"
                name="streamUrl"
                defaultValue={event?.streamUrl ?? ""}
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
                placeholder="https://twitch.tv/..."
              />
            </div>
          </div>
        </section>

        {/* Registration */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 border-l-2 border-lsr-orange pl-4">
              <Users size={16} className="text-lsr-orange/60" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Registration</h3>
            </div>
            <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                    <Label htmlFor="registrationEnabled" className="uppercase tracking-widest text-[10px] text-white/60 cursor-pointer">Enabled</Label>
                    <Switch id="registrationEnabled" name="registrationEnabled" defaultChecked={event?.registrationEnabled ?? false} className="data-[state=checked]:bg-lsr-orange" />
                </div>
                <div className="flex items-center gap-2">
                    <Label htmlFor="registrationWaitlistEnabled" className="uppercase tracking-widest text-[10px] text-white/60 cursor-pointer">Waitlist</Label>
                    <Switch id="registrationWaitlistEnabled" name="registrationWaitlistEnabled" defaultChecked={event?.registrationWaitlistEnabled ?? false} className="data-[state=checked]:bg-lsr-orange" />
                </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
            <div className="space-y-2">
              <label htmlFor="registrationOpensAt" className="text-[10px] uppercase tracking-wider text-white/60">Opens At</label>
              <Input 
                id="registrationOpensAt" 
                name="registrationOpensAt" 
                type="datetime-local" 
                key={`reg-open-${timezone}`}
                defaultValue={dateToZonedValue(event?.registrationOpensAt, timezone)} 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="registrationClosesAt" className="text-[10px] uppercase tracking-wider text-white/60">Closes At</label>
              <Input 
                id="registrationClosesAt" 
                name="registrationClosesAt" 
                type="datetime-local" 
                key={`reg-close-${timezone}`}
                defaultValue={dateToZonedValue(event?.registrationClosesAt, timezone)} 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="registrationMax" className="text-[10px] uppercase tracking-wider text-white/60">Capacity Limit</label>
              <Input
                id="registrationMax"
                name="registrationMax"
                type="number"
                defaultValue={event?.registrationMax ?? ""}
                placeholder="Unlimited"
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors w-1/2"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="registrationFeeCents" className="text-[10px] uppercase tracking-wider text-white/60">Registration Fee (USD)</label>
              <div className="flex items-center gap-2">
                <span className="text-white/40 text-sm">$</span>
                <Input
                  id="registrationFeeCents"
                  name="registrationFeeCents"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={centsToDollarInput(event?.registrationFeeCents || null)}
                  placeholder="0.00 (Free)"
                  className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors w-1/3"
                />
              </div>
              <p className="text-[10px] text-white/30">Leave blank for free events. Setting a fee requires Stripe payment before registration.</p>
            </div>
          </div>
        </section>

        {/* Check-in */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 border-l-2 border-lsr-orange pl-4">
              <QrCode size={16} className="text-lsr-orange/60" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Check-in</h3>
            </div>
            <div className="flex items-center gap-2">
                <Label htmlFor="attendanceEnabled" className="uppercase tracking-widest text-[10px] text-white/60 cursor-pointer">Enabled</Label>
                <Switch id="attendanceEnabled" name="attendanceEnabled" defaultChecked={event?.attendanceEnabled ?? false} className="data-[state=checked]:bg-lsr-orange" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
            <div className="space-y-2">
              <label htmlFor="attendanceOpensAt" className="text-[10px] uppercase tracking-wider text-white/60">Check-in Opens</label>
              <Input 
                id="attendanceOpensAt" 
                name="attendanceOpensAt" 
                type="datetime-local" 
                key={`att-open-${timezone}`}
                defaultValue={dateToZonedValue(event?.attendanceOpensAt, timezone)} 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="attendanceClosesAt" className="text-[10px] uppercase tracking-wider text-white/60">Check-in Closes</label>
              <Input 
                id="attendanceClosesAt" 
                name="attendanceClosesAt" 
                type="datetime-local" 
                key={`att-close-${timezone}`}
                defaultValue={dateToZonedValue(event?.attendanceClosesAt, timezone)} 
                className="bg-transparent border-b border-white/20 border-t-0 border-x-0 rounded-none px-0 h-8 focus-visible:ring-0 focus:border-lsr-orange transition-colors"
              />
            </div>
          </div>
        </section>

        {/* Publication */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 border-l-2 border-lsr-orange pl-4">
              <Megaphone size={16} className="text-lsr-orange/60" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Publication</h3>
            </div>
            {event && (
                <div className="flex items-center gap-3">
                    <span className="uppercase tracking-widest text-[10px] text-white/40">Current Status</span>
                    <span className="font-mono text-xs font-bold text-lsr-orange border border-lsr-orange/20 px-2 py-1 bg-lsr-orange/5">{event.status}</span>
                </div>
            )}
          </div>

          <div className="bg-white/[0.02] border border-white/5 p-6 md:p-8 space-y-6">
            {error && <p role="alert" className="border border-red-400/30 bg-red-500/10 px-4 py-3 font-sans text-xs leading-relaxed text-red-200">{error}</p>}
            <div className="flex flex-col lg:flex-row items-end gap-8">
                 <div className="flex flex-col gap-2 w-full lg:w-auto lg:flex-grow">
                    <Label htmlFor="scheduleDate" className="uppercase tracking-widest text-[10px] text-white/40">
                        Schedule Auto-Publish
                    </Label>
                    <div className="flex flex-col gap-1">
                        <Input 
                            type="datetime-local" 
                            name="scheduleDate" 
                            id="scheduleDate" 
                            key={`pub-date-${timezone}`}
                            defaultValue={event?.publishedAt ? dateToZonedValue(event.publishedAt, timezone) : ""}
                            className="bg-black/20 border-white/10 h-10 text-xs focus:border-lsr-orange w-full md:w-64"
                        />
                        <span className="text-[10px] text-white/20">Set a future date to automatically publish.</span>
                    </div>
                 </div>

                 <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-end">
                    <Button type="submit" name="submitAction" value="draft" disabled={pending} variant="ghost" className="text-white/40 hover:text-white font-bold uppercase tracking-widest text-[10px] h-10 px-4">
                        Save as Draft
                    </Button>
                    
                    <Button type="submit" name="submitAction" value="schedule" disabled={pending} variant="outline" className="border-white/20 text-white hover:bg-white/5 hover:border-lsr-orange hover:text-lsr-orange font-bold uppercase tracking-widest text-[10px] h-10 px-6">
                        Schedule
                    </Button>

                    <Button type="submit" name="submitAction" value="publish" disabled={pending} className="bg-lsr-orange hover:bg-lsr-orange/90 text-white font-bold uppercase tracking-widest text-[10px] h-10 px-8 shadow-lg">
                        {event ? "Publish / Save" : "Publish Now"}
                    </Button>
                 </div>
            </div>
          </div>
        </section>
      </form>
    </div>
  );
}