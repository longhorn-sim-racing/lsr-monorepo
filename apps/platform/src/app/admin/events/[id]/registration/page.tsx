
import { getEventForAdmin } from "@/server/queries/events";
import { RegistrationConfigForm } from "@/components/admin/registration-config-form";
import { RegistrationManager } from "@/components/admin/registration-manager";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { requireOfficerPage } from "@/server/auth/guards";

type ManageRegistrationArgs = {
  params: Promise<{ id: string }>;
};

export default async function ManageRegistrationPage({ params }: ManageRegistrationArgs) {
  await requireOfficerPage();
  const { id } = await params;
  const [event, registrations] = await Promise.all([
    getEventForAdmin(id),
    prisma.eventRegistration.findMany({
      where: { eventId: id },
      include: { user: true },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  if (!event) {
    return notFound();
  }

  return (
    <main className="mx-auto max-w-4xl p-8 pb-32">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Manage Registration: {event.title}</h1>
        <Button asChild variant="outline">
            <Link href="/admin/events">Back to Events</Link>
        </Button>
      </div>
      
      <div className="space-y-12">
        <RegistrationConfigForm event={event} />
        <RegistrationManager eventId={event.id} registrations={registrations} />
      </div>
    </main>
  );
}
