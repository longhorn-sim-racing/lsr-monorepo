import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getNotificationStats,
  getRecentNotifications,
  getScheduledNotifications,
  getEmailSettings,
} from "./actions";
import { NotificationActivity } from "./_components/notification-activity";
import { NotificationScheduled } from "./_components/notification-scheduled";
import { NotificationComposer } from "./_components/notification-composer";
import { NotificationSettings } from "./_components/notification-settings";
import { NotificationCleanup } from "./_components/notification-cleanup";
import { Bell, Send, Clock, Settings } from "lucide-react";
import { requireOfficerPage } from "@/server/auth/guards";
import { getEmailUsage } from "@/server/services/notification.service";

export const dynamic = "force-dynamic";

export default async function AdminNotificationsPage() {
  await requireOfficerPage();
  const [stats, recentNotifications, scheduledNotifications, emailSettings, emailUsage] =
    await Promise.all([
      getNotificationStats(),
      getRecentNotifications(),
      getScheduledNotifications(),
      getEmailSettings(),
      getEmailUsage(),
    ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Notifications</h1>
        <p className="text-white/60 mt-1">
          Manage notification delivery and send custom messages
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total"
          value={stats.total}
          color="bg-white/10"
        />
        <StatCard
          label="Pending"
          value={stats.pending}
          color="bg-yellow-500/20"
        />
        <StatCard
          label="Sent"
          value={stats.sent}
          color="bg-green-500/20"
        />
        <StatCard
          label="Failed"
          value={stats.failed}
          color="bg-red-500/20"
        />
      </div>

      <Tabs defaultValue="activity" className="w-full">
        <TabsList className="bg-white/5 border border-white/10 rounded-none p-1 w-full md:w-auto">
          <TabsTrigger
            value="activity"
            className="rounded-none data-[state=active]:bg-lsr-orange data-[state=active]:text-white gap-2"
          >
            <Bell className="h-4 w-4" />
            Activity
          </TabsTrigger>
          <TabsTrigger
            value="scheduled"
            className="rounded-none data-[state=active]:bg-lsr-orange data-[state=active]:text-white gap-2"
          >
            <Clock className="h-4 w-4" />
            Scheduled
          </TabsTrigger>
          <TabsTrigger
            value="compose"
            className="rounded-none data-[state=active]:bg-lsr-orange data-[state=active]:text-white gap-2"
          >
            <Send className="h-4 w-4" />
            Compose
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="rounded-none data-[state=active]:bg-lsr-orange data-[state=active]:text-white gap-2"
          >
            <Settings className="h-4 w-4" />
            Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="mt-6">
          <NotificationActivity notifications={recentNotifications} />
        </TabsContent>

        <TabsContent value="scheduled" className="mt-6">
          <NotificationScheduled notifications={scheduledNotifications} />
        </TabsContent>

        <TabsContent value="compose" className="mt-6">
          <NotificationComposer emailUsage={emailUsage} />
        </TabsContent>

        <TabsContent value="settings" className="mt-6 space-y-6">
          <NotificationSettings settings={emailSettings} resendKeyConfigured={!!process.env.RESEND_API_KEY} />
          <NotificationCleanup />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className={`${color} border border-white/10 p-4`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">
        {label}
      </p>
      <p className="text-3xl font-bold text-white mt-1">
        {value.toLocaleString()}
      </p>
    </div>
  );
}
