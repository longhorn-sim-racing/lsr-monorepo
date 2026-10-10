"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { Check, ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
};

export function NotificationList({
  notifications: initialNotifications,
}: {
  notifications: Notification[];
}) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [markingAll, setMarkingAll] = useState(false);
  const router = useRouter();

  const unreadCount = notifications.filter((n) => !n.readAt).length;
  const readCount = notifications.filter((n) => n.readAt).length;
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingRead, setClearingRead] = useState(false);

  const markAsRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: new Date() } : n))
      );
    } catch (error) {
      console.error("Failed to mark notification as read:", error);
    }
  };

  const markAllAsRead = async () => {
    setMarkingAll(true);
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markAllRead" }),
      });
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date() }))
      );
      router.refresh();
    } catch (error) {
      console.error("Failed to mark all notifications as read:", error);
    } finally {
      setMarkingAll(false);
    }
  };

  const dismissNotification = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", notificationId: id }),
      });
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      router.refresh();
    } catch (error) {
      console.error("Failed to dismiss notification:", error);
    } finally {
      setDeletingId(null);
    }
  };

  const dismissAllRead = async () => {
    setClearingRead(true);
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismissAllRead" }),
      });
      setNotifications((prev) => prev.filter((n) => !n.readAt));
      router.refresh();
    } catch (error) {
      console.error("Failed to dismiss read notifications:", error);
    } finally {
      setClearingRead(false);
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "REGISTRATION_CONFIRMED":
        return { label: "Registration", color: "bg-green-500" };
      case "WAITLIST_PROMOTED":
      case "PAYMENT_WAITLISTED":
        return { label: "Waitlist", color: "bg-lsr-orange" };
      case "EVENT_REMINDER_24H":
        return { label: "Reminder", color: "bg-blue-500" };
      case "EVENT_POSTED":
        return { label: "New Event", color: "bg-purple-500" };
      case "REGISTRATION_OPENED":
        return { label: "Registration Open", color: "bg-teal-500" };
      case "RESULTS_POSTED":
        return { label: "Results", color: "bg-yellow-500" };
      case "CUSTOM":
        return { label: "Announcement", color: "bg-white/30" };
      default:
        return { label: "Notification", color: "bg-white/20" };
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <p className="text-sm text-white/50">
          {unreadCount > 0 && (
            <>
              <span className="text-lsr-orange font-bold">{unreadCount}</span>{" "}
              unread
            </>
          )}
          {unreadCount > 0 && readCount > 0 && " · "}
          {readCount > 0 && (
            <>
              <span className="text-white/70 font-bold">{readCount}</span> read
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Button
              onClick={markAllAsRead}
              disabled={markingAll}
              variant="ghost"
              size="sm"
              className="text-lsr-orange hover:text-white hover:bg-white/5 rounded-none"
            >
              <Check className="h-4 w-4 mr-2" />
              Mark all read
            </Button>
          )}
          {readCount > 0 && (
            <Button
              onClick={dismissAllRead}
              disabled={clearingRead}
              variant="ghost"
              size="sm"
              className="text-white/50 hover:text-red-500 hover:bg-red-500/10 rounded-none"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear read
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-none border border-white/5 bg-white/[0.03] divide-y divide-white/5">
        {notifications.map((notification) => {
          const isUnread = !notification.readAt;
          const typeInfo = getTypeLabel(notification.type);
          const timeAgo = formatDistanceToNow(new Date(notification.createdAt), {
            addSuffix: true,
          });

          return (
            <div
              key={notification.id}
              className={`p-6 transition-colors ${isUnread ? "bg-white/[0.02]" : ""}`}
            >
              <div className="flex gap-4">
                <div className="flex-shrink-0 pt-1">
                  <div
                    className={`w-3 h-3 rounded-full ${typeInfo.color}`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider ${
                            isUnread ? "text-lsr-orange" : "text-white/40"
                          }`}
                        >
                          {typeInfo.label}
                        </span>
                        <span className="text-[10px] text-white/30">
                          {timeAgo}
                        </span>
                      </div>
                      <h3
                        className={`font-medium ${
                          isUnread ? "text-white" : "text-white/70"
                        }`}
                      >
                        {notification.title}
                      </h3>
                      <p className="text-sm text-white/50 mt-1">
                        {notification.body}
                      </p>
                    </div>
                    {isUnread && (
                      <div className="w-2 h-2 rounded-full bg-lsr-orange flex-shrink-0 mt-2" />
                    )}
                  </div>

                  <div className="flex items-center gap-4 mt-4">
                    {notification.actionUrl && (
                      <Link
                        href={notification.actionUrl}
                        onClick={() => {
                          if (isUnread) markAsRead(notification.id);
                        }}
                        className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-lsr-orange hover:text-white transition-colors"
                      >
                        View Details
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                    {isUnread && (
                      <button
                        onClick={() => markAsRead(notification.id)}
                        className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white transition-colors"
                      >
                        <Check className="h-3 w-3" />
                        Mark as read
                      </button>
                    )}
                    <button
                      onClick={() => dismissNotification(notification.id)}
                      disabled={deletingId === notification.id}
                      className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-red-500 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
