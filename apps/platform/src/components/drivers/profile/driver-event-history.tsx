import Link from "next/link";

type DriverEventHistoryProps = {
  eventHistory: any[];
};

export function DriverEventHistory({ eventHistory }: DriverEventHistoryProps) {
  return (
    <div className="mb-12">
        <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6 border-b border-white/10 pb-4">
            Event <span className="text-lsr-orange">Participation</span>
        </h3>
        {eventHistory.length > 0 ? (
            <div className="border border-white/10 bg-white/[0.02]">
                {eventHistory.map((attendance) => {
                    const event = attendance.event;
                    const row = (
                        <div className="flex items-center justify-between p-4 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
                            <div>
                                <div className="font-sans font-bold text-sm text-white uppercase tracking-tight group-hover:text-lsr-orange transition-colors">{event.title}</div>
                                <div className="font-mono text-[10px] text-white/40">{new Date(event.startsAtUtc).toLocaleDateString()}</div>
                            </div>
                            <div className="text-right">
                                <span className="inline-block border border-white/10 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-white/60">
                                    Attended
                                </span>
                            </div>
                        </div>
                    );

                    return event.slug ? (
                        <Link key={attendance.id} href={`/events/${event.slug}`} className="block group">
                            {row}
                        </Link>
                    ) : (
                        <div key={attendance.id}>{row}</div>
                    );
                })}
            </div>
        ) : (
            <div className="border border-white/10 bg-white/[0.02] p-8 text-center">
                <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-xs">No event attendance recorded</p>
            </div>
        )}
    </div>
  );
}
