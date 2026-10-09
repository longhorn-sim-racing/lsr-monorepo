import { redirect } from "next/navigation";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { prisma } from "@/server/db";
import { NotificationList } from "./notification-list";
import { Bell } from "lucide-react";
import Link from "next/link";
import { AccountHeader } from "../account-header";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { user } = await getCachedSessionUser();
  if (!user) redirect("/auth/signin?next=/account/notifications");

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const pageSize = 20;

  const [notifications, totalCount] = await Promise.all([
    prisma.notification.findMany({
      where: {
        userId: user.id,
        channel: "IN_APP",
        status: "SENT",
        dismissedAt: null,
      },
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        actionUrl: true,
        readAt: true,
        sentAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.notification.count({
      where: {
        userId: user.id,
        channel: "IN_APP",
        status: "SENT",
        dismissedAt: null,
      },
    }),
  ]);

  const totalPages = Math.ceil(totalCount / pageSize);

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <AccountHeader user={user} active="notifications" kicker="Your account" />
      <div className="mx-auto max-w-5xl px-6 md:px-8 py-12 md:py-16 space-y-8">
        <div>
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Inbox</p>
          <h2 className="mt-2 font-display font-black italic text-3xl uppercase leading-none text-white">Notifications</h2>
          <p className="mt-3 max-w-2xl font-sans text-sm leading-relaxed text-white/60">
            Registration updates, waitlist moves and club news. Choose which ones you also get by email in{" "}
            <Link href="/account#email" className="font-bold text-lsr-orange hover:text-white">
              your settings
            </Link>
            .
          </p>
        </div>

        {notifications.length === 0 ? (
          <div className="relative border border-white/10 bg-white/[0.02] p-10 text-center md:p-14">
            <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
            <Bell className="mx-auto mb-4 h-10 w-10 text-white/25" aria-hidden />
            <p className="font-display font-black italic text-2xl uppercase text-white/80">Nothing here yet</p>
            <p className="mt-2 font-sans text-sm text-white/50">When something needs your attention, it shows up here.</p>
          </div>
        ) : (
          <>
            <NotificationList notifications={notifications} />

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                {page > 1 && (
                  <Link
                    href={`/account/notifications?page=${page - 1}`}
                    className="px-4 py-2 text-sm font-bold uppercase tracking-wider text-white/60 hover:text-lsr-orange border border-white/10 hover:border-lsr-orange transition-colors"
                  >
                    Previous
                  </Link>
                )}
                <span className="px-4 py-2 text-sm text-white/40">
                  Page {page} of {totalPages}
                </span>
                {page < totalPages && (
                  <Link
                    href={`/account/notifications?page=${page + 1}`}
                    className="px-4 py-2 text-sm font-bold uppercase tracking-wider text-white/60 hover:text-lsr-orange border border-white/10 hover:border-lsr-orange transition-colors"
                  >
                    Next
                  </Link>
                )}
              </div>
            )}

            <p className="text-center text-xs text-white/30">
              Showing {(page - 1) * pageSize + 1}-
              {Math.min(page * pageSize, totalCount)} of {totalCount}{" "}
              notifications
            </p>
          </>
        )}
      </div>
    </div>
  );
}
