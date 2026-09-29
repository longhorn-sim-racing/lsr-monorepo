"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Calendar,
  Trophy,
  MapPin,
  Image as ImageIcon,
  Newspaper,
  Wrench,
  FileSpreadsheet,
  Users,
  Car,
  List,
  Bell,
  IdCard,
  Timer,
  Flag,
  CreditCard,
  Package,
} from "lucide-react";

const pinnedItems = [
  { title: "Audit Console", href: "/admin", icon: List },
];

const navItems = [
  { title: "Car Mappings", href: "/admin/cars", icon: Car },
  { title: "Driver Mappings", href: "/admin/drivers", icon: IdCard },
  { title: "Events", href: "/admin/events", icon: Calendar },
  { title: "Gallery", href: "/admin/gallery", icon: ImageIcon },
  { title: "Hotlap", href: "/admin/hotlap", icon: Timer },
  { title: "LSC Entrants", href: "/admin/league-entries", icon: Flag },
  { title: "Misc. Tools", href: "/admin/tools", icon: Wrench },
  { title: "News", href: "/admin/news", icon: Newspaper },
  { title: "Notifications", href: "/admin/notifications", icon: Bell },
  { title: "Payments", href: "/admin/payments", icon: CreditCard },
  { title: "Products", href: "/admin/products", icon: Package },
  { title: "Results", href: "/admin/results", icon: FileSpreadsheet },
  { title: "Seasons", href: "/admin/seasons", icon: Trophy },
  { title: "Series", href: "/admin/series", icon: LayoutDashboard },
  { title: "User Management", href: "/admin/users", icon: Users },
  { title: "Venues", href: "/admin/venues", icon: MapPin },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-white/10 bg-black/50 min-h-[calc(100vh-4rem)] hidden md:block">
      <div className="p-4">
        <h2 className="text-lg font-bold text-white/80 px-4 mb-4">Admin</h2>
        <nav className="space-y-1">
          {pinnedItems.map((item) => {
            const isActive = item.href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-4 py-2 text-sm font-medium rounded-md transition-colors",
                  isActive
                    ? "bg-lsr-orange text-white"
                    : "text-white/60 hover:bg-white/5 hover:text-white"
                )}
              >
                <item.icon size={16} />
                {item.title}
              </Link>
            );
          })}

          <div className="border-b border-white/10 mx-4 my-2" />

          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-4 py-2 text-sm font-medium rounded-md transition-colors",
                  isActive
                    ? "bg-lsr-orange text-white"
                    : "text-white/60 hover:bg-white/5 hover:text-white"
                )}
              >
                <item.icon size={16} />
                {item.title}
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
