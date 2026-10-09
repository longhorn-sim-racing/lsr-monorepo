import { redirect } from "next/navigation";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { prisma } from "@/server/db";
import { NotificationList } from "./notification-list";
import { Bell, ArrowLeft } from "lucide-react";
import Link from "next/link";

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
    <div className="bg-lsr-charcoal text-white min-h-screen pt-20 pb-20">
      <div className="mx-auto max-w-4xl px-6 md:px-8 space-y-8">
        <div>
          <Link
            href="/account"
            className="inline-flex items-center gap-2 text-white/50 hover:text-lsr-orange transition-colors text-sm mb-6"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Account
          </Link>
          <h1 className="font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal">
            Your <span className="text-lsr-orange">Notifications</span>
          </h1>
          <p className="font-sans font-medium text-white/60 mt-4 max-w-2xl leading-relaxed">
            View and manage all your in-app notifications.
          </p>
        </div>

        <div className="w-full h-px bg-white/5" />

        {notifications.length === 0 ? (
          <div className="rounded-none border border-white/5 bg-white/[0.03] p-12 text-center">
            <Bell className="h-12 w-12 mx-auto mb-4 text-white/20" />
            <p className="text-lg text-white/40">No notifications yet</p>
            <p className="text-sm text-white/30 mt-2">
              When you receive notifications, they&apos;ll appear here.
            </p>
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
