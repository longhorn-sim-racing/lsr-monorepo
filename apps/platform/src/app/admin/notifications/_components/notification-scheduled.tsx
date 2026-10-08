"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Notification } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Clock, Mail, Bell, X } from "lucide-react";
import { cancelScheduledNotification } from "../actions";

type NotificationWithUser = Notification & {
  user: { id: string; displayName: string; email: string };
};

export function NotificationScheduled({
  notifications,
}: {
  notifications: NotificationWithUser[];
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);

  const handleCancel = async (id: string) => {
    setCancelling(id);
    try {
      await cancelScheduledNotification(id);
    } finally {
      setCancelling(null);
    }
  };

  if (notifications.length === 0) {
    return (
      <div className="border border-white/10 bg-white/[0.02] p-8 text-center">
        <Clock className="h-12 w-12 mx-auto text-white/20 mb-4" />
        <p className="text-white/60">No scheduled notifications</p>
        <p className="text-sm text-white/40 mt-2">
          Schedule notifications in the Compose tab
        </p>
      </div>
    );
  }

  return (
    <div className="border border-white/10 bg-white/[0.02]">
      {/* Header */}
      <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-white/10 text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">
        <div className="col-span-3">User</div>
        <div className="col-span-3">Title</div>
        <div className="col-span-2">Channel</div>
        <div className="col-span-3">Scheduled For</div>
        <div className="col-span-1"></div>
      </div>

      {/* Rows */}
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className="grid grid-cols-12 gap-4 px-4 py-3 items-center border-b border-white/5 last:border-b-0 hover:bg-white/[0.02]"
        >
          <div className="col-span-3">
            <p className="text-sm font-medium text-white truncate">
              {notification.user.displayName}
            </p>
            <p className="text-xs text-white/40 truncate">
              {notification.user.email}
            </p>
          </div>
          <div className="col-span-3">
            <p className="text-sm text-white truncate">{notification.title}</p>
            <p className="text-xs text-white/40 truncate">{notification.body}</p>
          </div>
          <div className="col-span-2">
            {notification.channel === "EMAIL" ? (
              <div className="flex items-center gap-1 text-white/60">
                <Mail className="h-3 w-3" />
                <span className="text-xs">Email</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-white/60">
                <Bell className="h-3 w-3" />
                <span className="text-xs">In-App</span>
              </div>
            )}
          </div>
          <div className="col-span-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-yellow-500" />
              <span className="text-sm text-white">
                {notification.scheduledFor
                  ? format(new Date(notification.scheduledFor), "MMM d, h:mm a")
                  : "-"}
              </span>
            </div>
          </div>
          <div className="col-span-1 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCancel(notification.id)}
              disabled={cancelling === notification.id}
              className="rounded-none hover:bg-red-500/20 hover:text-red-500 p-2"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
