"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { RacingNumber, type RacingNumberStyle } from "@/components/racing-number";
import { formatCents } from "@/lib/money";

type Attendee = RacingNumberStyle & {
  displayName: string;
  avatarUrl: string | null;
  profileLink: string;
};

type RegistrationSnapshot = {
  registrationEnabled: boolean;
  windowStatus: "OPEN" | "CLOSED" | "NOT_OPEN" | "DISABLED" | "PASSED";
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  capacity: number | null;
  registeredCount: number;
  waitlistEnabled: boolean;
  waitlistCount: number;
  myStatus: "REGISTERED" | "WAITLISTED" | "NOT_ATTENDING" | "NONE";
  attendees: Attendee[];
  registrationFeeCents: number | null;
};

export function EventRegistrationPanel({
  eventSlug,
  userLoggedIn,
  attendeesOnly = false,
}: {
  eventSlug: string;
  userLoggedIn: boolean;
  /** Just the drivers list, for events that are over */
  attendeesOnly?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<RegistrationSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Handle payment return query params
  useEffect(() => {
    const payment = searchParams.get("payment");
    if (payment === "success") {
      toast.success("Payment confirmed! You're registered.");
    } else if (payment === "cancelled") {
      toast("Payment was cancelled. You have not been registered.");
    }
  }, [searchParams]);

  const fetchSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/events/${eventSlug}/registration`);
      if (res.ok) {
        const data = await res.json();
        setSnapshot(data);
      }
    } catch (err) {
      console.error("Failed to fetch registration status", err);
    } finally {
      setLoading(false);
    }
  }, [eventSlug]);

  // Again when someone signs in or out, since the snapshot includes their own registration
  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot, userLoggedIn]);

  const handleAction = async (intent: "YES" | "NO") => {
    if (!userLoggedIn) return;
    
    setActionLoading(true);
    try {
      const res = await fetch(`/api/events/${eventSlug}/registration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      
      if (res.ok) {
        const updatedSnapshot = await res.json();
        setSnapshot(updatedSnapshot);
        router.refresh(); 
      } else {
        const err = await res.json();
        alert(err.message || "Registration failed");
      }
    } catch (e) {
      console.error(e);
      alert("An error occurred");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCheckout = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/events/${eventSlug}/checkout`, {
        method: "POST",
      });
      if (res.ok) {
        const { url } = await res.json();
        window.location.href = url;
      } else {
        const err = await res.json();
        toast.error(err.message || "Could not start checkout");
      }
    } catch (e) {
      console.error(e);
      toast.error("An error occurred starting checkout");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && !snapshot) {
    if (attendeesOnly) return null;
    return <div className="pt-6 border-t border-white/10 text-center text-white/40 text-xs animate-pulse">Loading registration...</div>;
  }

  if (!snapshot) return null;

  const attendeeList = snapshot.attendees.length > 0 && (
    <div className="pt-6 border-t border-white/10">
        <h3 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/30 mb-4">
            Drivers List ({snapshot.attendees.length})
        </h3>
        <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
            {snapshot.attendees.map((attendee, idx) => (
                <Link
                    key={idx}
                    href={attendee.profileLink}
                    className="flex items-center gap-3 p-2 hover:bg-white/5 transition-colors group border border-transparent hover:border-white/5"
                >
                    <Avatar className="h-6 w-6 border border-white/10 group-hover:border-lsr-orange/50 transition-colors rounded-none">
                        <AvatarImage src={attendee.avatarUrl || undefined} className="rounded-none" />
                        <AvatarFallback className="text-[9px] bg-white/10 text-white rounded-none">
                            {attendee.displayName[0]}
                        </AvatarFallback>
                    </Avatar>
                    <span className="text-xs font-bold text-white/70 group-hover:text-white transition-colors truncate">
                        {attendee.displayName}
                    </span>
                    <RacingNumber user={attendee} size="xs" className="text-xs shrink-0" />
                </Link>
            ))}
        </div>
    </div>
  );

  if (attendeesOnly) return attendeeList || null;

  if (snapshot.windowStatus === "DISABLED") {
    return (
        <div className="pt-6 border-t border-white/10 text-center text-white/40 text-[10px] uppercase tracking-widest font-bold">
            Registration not required for this event.
        </div>
    );
  }

  if (!userLoggedIn) {
    return (
      <div className="pt-6 border-t border-white/10 text-center space-y-4">
        <p className="text-white/40 text-[10px] uppercase tracking-widest font-bold px-2">
            Registration and attendee lists are restricted to members only.
        </p>
        <Button 
          className="w-full rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-black uppercase tracking-[0.1em] text-[10px] h-12 transition-all"
          onClick={() => {
             window.dispatchEvent(new CustomEvent("open-auth-dialog")); 
          }}
        >
          Log In to Register
        </Button>
      </div>
    );
  }

  const isFull = snapshot.capacity !== null && snapshot.registeredCount >= snapshot.capacity;
  const canRegister = snapshot.windowStatus === "OPEN" && (!isFull || snapshot.waitlistEnabled);
  const myStatus = snapshot.myStatus;
  const isPaidEvent = snapshot.registrationFeeCents != null && snapshot.registrationFeeCents > 0;

  return (
    <div className="space-y-6">
      {/* STATUS & CONTROLS */}
      <div className="pt-6 border-t border-white/10 space-y-4">
        {/* Status Display */}
        <div className="flex justify-between items-center text-sm">
            <span className="font-bold uppercase tracking-widest text-white/60 text-[10px]">Your Status</span>
            <Badge 
                variant={myStatus === "REGISTERED" ? "default" : myStatus === "WAITLISTED" ? "secondary" : "outline"}
                className={cn(
                    "rounded-none font-bold uppercase tracking-wider text-[10px]",
                    myStatus === "REGISTERED" && "bg-green-600 hover:bg-green-600 text-white border-none",
                    myStatus === "WAITLISTED" && "bg-yellow-600 hover:bg-yellow-600 text-white border-none",
                    (myStatus === "NONE" || myStatus === "NOT_ATTENDING") && "text-white/40 border-white/20"
                )}
            >
                {myStatus === "NONE" ? "Not Registered" : myStatus.replace("_", " ")}
            </Badge>
        </div>

        {/* Counts */}
        <div className="flex justify-between items-center text-xs text-white/40">
            <span className="uppercase tracking-widest text-[9px]">Capacity</span>
            <span className="font-mono">
                {snapshot.registeredCount} / {snapshot.capacity === null ? "∞" : snapshot.capacity}
                {snapshot.waitlistEnabled && snapshot.waitlistCount > 0 && (
                    <span className="ml-2 text-yellow-500">({snapshot.waitlistCount} Waitlisted)</span>
                )}
            </span>
        </div>

        {/* Action Buttons */}
        {snapshot.windowStatus === "OPEN" ? (
            <>
                {isFull && !snapshot.waitlistEnabled && myStatus !== "REGISTERED" && myStatus !== "WAITLISTED" ? (
                    <div className="text-center py-3 bg-white/5 text-white/40 text-[10px] font-bold uppercase tracking-widest border border-white/5">
                        Event is at capacity and waitlist is disabled.
                    </div>
                ) : (
                    <div className={cn("grid gap-3", (myStatus === "REGISTERED" || myStatus === "WAITLISTED") ? "grid-cols-2" : "grid-cols-1")}>
                        <Button
                            onClick={() => {
                              if (isPaidEvent && !isFull && myStatus !== "REGISTERED" && myStatus !== "WAITLISTED") {
                                handleCheckout();
                              } else {
                                handleAction("YES");
                              }
                            }}
                            disabled={actionLoading || myStatus === "REGISTERED" || (myStatus === "WAITLISTED") || (!canRegister && myStatus === "NONE")}
                            className={cn(
                                "rounded-none font-black uppercase tracking-[0.1em] text-[10px] h-10 transition-all",
                                myStatus === "REGISTERED" || myStatus === "WAITLISTED"
                                    ? "bg-white/10 text-white/40 cursor-default border border-transparent"
                                    : "bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal"
                            )}
                        >
                            {myStatus === "REGISTERED" ? "Registered" :
                            myStatus === "WAITLISTED" ? "On Waitlist" :
                            (isFull && snapshot.waitlistEnabled) ? "Join Waitlist" :
                            isPaidEvent ? `Register — ${formatCents(snapshot.registrationFeeCents!)}` :
                            "Attending"
                            }
                        </Button>
                        {(myStatus === "REGISTERED" || myStatus === "WAITLISTED") && (
                            <Button 
                                onClick={() => handleAction("NO")}
                                disabled={actionLoading}
                                className="rounded-none border border-white/20 bg-transparent text-white hover:bg-red-900/50 hover:border-red-500/50 hover:text-red-200 font-black uppercase tracking-[0.1em] text-[10px] h-10 transition-all"
                            >
                                Not Attending
                            </Button>
                        )}
                    </div>
                )}
            </>
        ) : (
            <div className="text-center py-3 bg-white/5 text-white/40 text-[10px] font-bold uppercase tracking-widest border border-white/5">
                {snapshot.windowStatus === "PASSED" && "This event has passed. Registration is not possible."}
                {snapshot.windowStatus === "CLOSED" && "Registration for this event has closed."}
                {snapshot.windowStatus === "NOT_OPEN" && `Registration opens ${snapshot.registrationOpensAt ? new Date(snapshot.registrationOpensAt).toLocaleString() : "soon"}`}
            </div>
        )}
      </div>

      {/* ATTENDEE LIST */}
      {attendeeList}
    </div>
  );
}
