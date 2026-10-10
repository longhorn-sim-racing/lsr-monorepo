"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateEventAttendanceConfig } from "@/app/admin/events/actions";
import { Event } from "@prisma/client";
import { dateToZonedValue, DEFAULT_TIMEZONE } from "@/lib/dates";
import { AlertCircle } from "lucide-react";

export function AttendanceConfigForm({ event, checkInCount = 0 }: { event: Event; checkInCount?: number }) {
  const timezone = event.timezone || DEFAULT_TIMEZONE;
  
  const [enabled, setEnabled] = useState(event.attendanceEnabled);
  const [opensAt, setOpensAt] = useState(dateToZonedValue(event.attendanceOpensAt, timezone));
  const [closesAt, setClosesAt] = useState(dateToZonedValue(event.attendanceClosesAt, timezone));

  const handleToggle = (checked: boolean) => {
      setEnabled(checked);
      if (checked) {
          if (!opensAt) setOpensAt(dateToZonedValue(event.startsAtUtc, timezone));
          if (!closesAt) setClosesAt(dateToZonedValue(event.endsAtUtc, timezone));
      }
  };

  return (
    <form action={updateEventAttendanceConfig.bind(null, event.id)} className="space-y-6 border border-white/10 bg-white/[0.02] p-6 rounded-lg">
      <h2 className="text-xl font-display font-black italic uppercase text-white">Attendance Settings</h2>
      
      <div className="p-4 border border-white/5 bg-white/5 rounded-md space-y-2">
        <div className="flex items-center space-x-3">
            <Switch 
                id="attendanceEnabled" 
                name="attendanceEnabled" 
                checked={enabled} 
                onCheckedChange={handleToggle}
            />
            <Label htmlFor="attendanceEnabled" className="font-sans font-bold uppercase tracking-widest text-xs cursor-pointer">Enable Check-in System</Label>
        </div>
        <p className="text-[10px] text-white/40 pl-12 leading-relaxed">
            When enabled, users must scan a QR code to be marked as &ldquo;Attended&rdquo;. 
            <br/>
            When disabled, all registered users are automatically assumed to have attended once the event concludes.
        </p>
      </div>

      {!enabled && event.attendanceEnabled && checkInCount > 0 && (
          <div className="flex items-start p-3 bg-red-500/10 border border-red-500/20 rounded text-red-200 text-xs gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                  Warning: Disabling attendance will hide the {checkInCount} existing check-ins from reports.
              </div>
          </div>
      )}

      <div className="space-y-4">
        <div>
          <Label htmlFor="attendanceOpensAt" className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5 block">Check-in Opens ({timezone})</Label>
          <Input 
            id="attendanceOpensAt" 
            name="attendanceOpensAt" 
            type="datetime-local" 
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            className="bg-black/20 border-white/10 text-xs font-mono"
          />
        </div>
        <div>
          <Label htmlFor="attendanceClosesAt" className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5 block">Check-in Closes ({timezone})</Label>
          <Input 
            id="attendanceClosesAt" 
            name="attendanceClosesAt" 
            type="datetime-local" 
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            className="bg-black/20 border-white/10 text-xs font-mono"
          />
        </div>
      </div>

      <Button type="submit" className="w-full bg-lsr-orange hover:bg-lsr-orange/90 text-white uppercase tracking-widest text-xs font-bold h-10">
        Update Configuration
      </Button>
    </form>
  );
}
