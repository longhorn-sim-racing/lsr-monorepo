"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AlertCircle, CalendarCheck, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type CheckInState =
  | { status: "IDLE" }
  | { status: "LOADING" }
  | { status: "SUCCESS"; timestamp: string }
  | { status: "ERROR"; message: string };

type CheckInStatus = "OPEN" | "NOT_ENABLED" | "NOT_OPEN_YET" | "CLOSED" | "ALREADY_CHECKED_IN";

type CheckInViewProps = {
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  /** The event's time zone, for the time shown after checking in */
  timeZone: string;
  status: CheckInStatus;
  /** Pre-formatted on the server in the event's time zone, so both renders match */
  opensAt?: { time: string; date: string };
  checkedInAt?: string;
  currentUser: {
    displayName: string;
    handle: string;
    avatarUrl: string | null;
  };
};

const secondary =
  "h-12 w-full rounded-none border border-white/15 bg-transparent font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white hover:bg-white hover:text-lsr-charcoal";

/** The card every check-in state sits in */
function Panel({ tone = "default", icon, kicker, title, children }: { tone?: "default" | "success" | "warn" | "error"; icon: React.ReactNode; kicker: string; title: string; children: React.ReactNode }) {
  const ring = {
    default: "bg-white/5 text-white/60 border-white/10",
    success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    warn: "bg-lsr-orange/10 text-lsr-orange border-lsr-orange/30",
    error: "bg-red-500/10 text-red-300 border-red-500/30",
  }[tone];
  return (
    <div className="relative w-full max-w-md border border-white/10 bg-lsr-charcoal/85 p-7 shadow-2xl backdrop-blur-md md:p-9">
      <div className={`absolute top-0 left-0 h-1 ${tone === "success" ? "w-full bg-emerald-400" : "w-24 bg-lsr-orange"}`} />
      <span className={`flex h-14 w-14 items-center justify-center border ${ring}`}>{icon}</span>
      <p className="mt-6 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
      <h1 className="mt-2 font-display font-black italic text-4xl uppercase leading-[0.95] text-white">{title}</h1>
      <div className="mt-6 space-y-6">{children}</div>
    </div>
  );
}

export function CheckInView({ eventId, eventSlug, eventTitle, timeZone, status, opensAt, checkedInAt, currentUser }: CheckInViewProps) {
  const [viewState, setViewState] = useState<CheckInState>(() =>
    status === "ALREADY_CHECKED_IN" && checkedInAt ? { status: "SUCCESS", timestamp: checkedInAt } : { status: "IDLE" },
  );

  async function handleCheckIn() {
    setViewState({ status: "LOADING" });
    try {
      const res = await fetch(`/api/check-in/${eventId}`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Failed to check in");
      }

      setViewState({
        status: "SUCCESS",
        timestamp: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }),
      });
    } catch (err: unknown) {
      setViewState({ status: "ERROR", message: err instanceof Error ? err.message : "Failed to check in" });
    }
  }

  const backToEvent = (
    <Button asChild className={secondary}>
      <Link href={`/events/${eventSlug}`}>Event page</Link>
    </Button>
  );

  if (viewState.status === "SUCCESS") {
    return (
      <Panel tone="success" icon={<CheckCircle2 className="h-7 w-7" aria-hidden />} kicker={eventTitle} title="You're checked in">
        <p className="font-sans text-sm leading-relaxed text-white/70" role="status">
          Recorded at <span className="font-bold text-white">{viewState.timestamp}</span>. It counts toward your attendance on your driver page.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {backToEvent}
          <Button asChild className="h-12 w-full rounded-none bg-lsr-orange font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white hover:bg-white hover:text-lsr-charcoal">
            <Link href={`/drivers/${currentUser.handle}`}>Your driver page</Link>
          </Button>
        </div>
      </Panel>
    );
  }

  if (status === "NOT_ENABLED") {
    return (
      <Panel icon={<CalendarCheck className="h-7 w-7" aria-hidden />} kicker={eventTitle} title="No check-in needed">
        <p className="font-sans text-sm leading-relaxed text-white/70">This event doesn&apos;t use check-in. Your registration is all you need.</p>
        {backToEvent}
      </Panel>
    );
  }

  if (status === "NOT_OPEN_YET") {
    return (
      <Panel tone="warn" icon={<Clock className="h-7 w-7" aria-hidden />} kicker={eventTitle} title="Not open yet">
        {opensAt && (
          <div className="border border-white/10 bg-black/30 p-5">
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/50">Check-in opens</p>
            <p className="mt-2 font-display font-black italic text-4xl leading-none text-white">{opensAt.time}</p>
            <p className="mt-1 font-sans text-sm text-white/60">{opensAt.date}</p>
          </div>
        )}
        <p className="font-sans text-sm text-white/60">Scan the code again once it&apos;s open.</p>
        {backToEvent}
      </Panel>
    );
  }

  if (status === "CLOSED") {
    return (
      <Panel tone="error" icon={<AlertCircle className="h-7 w-7" aria-hidden />} kicker={eventTitle} title="Check-in closed">
        <p className="font-sans text-sm leading-relaxed text-white/70">Check-in for this event has ended. If you were there, find an officer and they can add you.</p>
        {backToEvent}
      </Panel>
    );
  }

  // OPEN
  return (
    <Panel icon={<CalendarCheck className="h-7 w-7 text-lsr-orange" aria-hidden />} kicker="Event check-in" title={eventTitle}>
      <Link href={`/drivers/${currentUser.handle}`} className="group flex items-center gap-3 border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-white/25">
        <span className="relative h-11 w-11 shrink-0 overflow-hidden border border-white/10 bg-black">
          {currentUser.avatarUrl ? (
            <Image src={currentUser.avatarUrl} alt="" fill sizes="44px" className="object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center font-display font-black italic text-white/40">{currentUser.displayName[0]}</span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-sans font-bold text-sm text-white group-hover:text-lsr-orange">{currentUser.displayName}</span>
          <span className="block truncate font-sans text-xs text-white/50">Checking in as @{currentUser.handle}</span>
        </span>
      </Link>

      {viewState.status === "ERROR" && (
        <div role="alert" className="flex items-start gap-3 border border-red-500/30 bg-red-500/10 px-4 py-3 font-sans text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {viewState.message}
        </div>
      )}

      <Button
        size="lg"
        className="h-16 w-full rounded-none bg-lsr-orange font-sans text-sm font-bold uppercase tracking-[0.2em] text-white shadow-[0_0_30px_rgba(255,128,0,0.25)] hover:bg-white hover:text-lsr-charcoal"
        onClick={handleCheckIn}
        disabled={viewState.status === "LOADING"}
      >
        {viewState.status === "LOADING" ? (
          <>
            <Loader2 className="mr-3 h-5 w-5 animate-spin" />
            Checking in…
          </>
        ) : (
          "Check in"
        )}
      </Button>

      <Link href={`/events/${eventSlug}`} className="block text-center font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45 hover:text-white">
        Not now
      </Link>
    </Panel>
  );
}
