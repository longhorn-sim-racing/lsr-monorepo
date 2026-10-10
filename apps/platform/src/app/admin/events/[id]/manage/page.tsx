import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getEventAttendanceState } from "@/server/services/attendance.service";
import { RegistrationConfigForm } from "@/components/admin/registration-config-form";
import { RegistrationManager } from "@/components/admin/registration-manager";
import { AttendanceConfigForm } from "@/components/admin/attendance-config-form";
import { AttendanceManager } from "@/components/admin/attendance-manager";
import { generateQrCodeDataUrl } from "@/lib/qr";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { LiveTailButton } from "@/components/admin/live-tail-button";
import { requireOfficerPage } from "@/server/auth/guards";
import { getSiteUrl } from "@/lib/site-url";

export default async function ManageEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage();
  const { id } = await params;

  // 1. Fetch Event & Registration Data (Combined logic or separate)
  // We can use getEventAttendanceState for attendance stuff.
  // RegistrationManager needs "registrations".
  
  const [attendanceState, allUsers] = await Promise.all([
    getEventAttendanceState(id).catch(() => null),
    prisma.user.findMany({
        select: { id: true, displayName: true, handle: true },
        orderBy: { displayName: 'asc' }
    })
  ]);

  if (!attendanceState) return notFound();

  const { event, lists } = attendanceState;

  // 2. Prepare QR (needs an absolute URL)
  const checkInUrl = `${getSiteUrl()}/check-in/${event.id}`;
  const qrDataUrl = await generateQrCodeDataUrl(checkInUrl);

  // 3. Prepare Registrations for RegistrationManager
  // It expects "RegistrationWithUser".
  // getEventAttendanceState uses "REGISTERED" status for stats, but RegistrationManager needs ALL (waitlisted etc).
  // So we might need to fetch all registrations separately or modify getEventAttendanceState.
  // Let's fetch all registrations here to be safe and compatible with RegistrationManager.
  const allRegistrations = await prisma.eventRegistration.findMany({
      where: { eventId: id },
      include: { user: true },
      orderBy: { createdAt: 'asc' }
  });

  return (
    <div className="mx-auto max-w-7xl p-6 md:p-12 pb-32">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
        <div>
            <div className="flex items-center gap-3 mb-2">
                <span className="bg-lsr-orange/10 text-lsr-orange px-2 py-0.5 text-[10px] font-black uppercase tracking-widest border border-lsr-orange/20">
                    Event Management
                </span>
                <span className="text-white/40 text-xs font-mono">{event.slug}</span>
            </div>
            <h1 className="font-display font-black italic text-3xl md:text-5xl text-white uppercase tracking-tight leading-none">
                {event.title}
            </h1>
        </div>
        <div className="flex gap-3">
            <LiveTailButton />
            <Button asChild variant="outline" className="border-white/10 hover:bg-white/5 uppercase tracking-widest text-xs font-bold h-10">
                <Link href="/admin/events">Exit</Link>
            </Button>
        </div>
      </div>
      
      <Tabs defaultValue="attendance" className="space-y-8">
          <TabsList className="w-full justify-start bg-transparent border-b border-white/10 p-0 h-auto rounded-none">
              <TabsTrigger 
                value="attendance" 
                className="rounded-none border-b-2 border-transparent px-6 py-3 font-sans font-bold text-sm uppercase tracking-widest text-white/40 data-[state=active]:border-lsr-orange data-[state=active]:bg-transparent data-[state=active]:text-white transition-all hover:text-white/70"
              >
                Attendance
              </TabsTrigger>
              <TabsTrigger 
                value="registration" 
                className="rounded-none border-b-2 border-transparent px-6 py-3 font-sans font-bold text-sm uppercase tracking-widest text-white/40 data-[state=active]:border-lsr-orange data-[state=active]:bg-transparent data-[state=active]:text-white transition-all hover:text-white/70"
              >
                Registration
              </TabsTrigger>
          </TabsList>

          <TabsContent value="attendance" className="space-y-8">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  <div className="lg:col-span-2">
                      <AttendanceManager 
                          eventId={event.id}
                          eventTitle={event.title}
                          checkInUrl={checkInUrl}
                          qrDataUrl={qrDataUrl}
                          checkedIn={lists.checkedIn}
                          missing={lists.missing}
                          walkIns={lists.walkIns}
                          allUsers={allUsers}
                      />
                  </div>
                  <div>
                      <AttendanceConfigForm event={event} checkInCount={lists.checkedIn.length} />
                  </div>
              </div>
          </TabsContent>

          <TabsContent value="registration" className="space-y-8">
               <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  <div className="lg:col-span-2">
                       <RegistrationManager eventId={event.id} registrations={allRegistrations} />
                  </div>
                  <div>
                      <RegistrationConfigForm event={event} />
                  </div>
               </div>
          </TabsContent>
      </Tabs>
    </div>
  );
}
