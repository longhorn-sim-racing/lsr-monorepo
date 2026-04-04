import "./globals.css"
import { Metadata, Viewport } from "next"
import { ThemeProvider } from "@/components/theme-provider"
import { Montserrat, Kanit } from "next/font/google"
import { SiteHeader } from "@/components/site-header"
import { Analytics } from "@vercel/analytics/react"
import { SpeedInsights } from "@vercel/speed-insights/next"
import React from "react";
import { SiteFooter } from "@/components/site-footer"
import { LiveBanner } from "@/components/live-banner";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { prisma } from "@/server/db";
import { Toaster } from "@/components/ui/sonner";
import { CartProvider } from "@/lib/shopify/CartContext";
import { RacingNumberPrompt } from "@/components/racing-number-prompt";

const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-sans", // for body text
  display: "swap",
})

const kanit = Kanit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  variable: "--font-display", // for headings
  display: "swap",
})

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#262626",
}

export const metadata: Metadata = {
  title: { default: "Longhorn Sim Racing | UT Austin", template: "%s | LSR" },
  description: "UT Austin Longhorn Sim Racing Club",
  metadataBase: new URL("https://www.longhornsimracing.org"),
  openGraph: {
    type: "website",
    siteName: "Longhorn Sim Racing",
    images: [
      {
        url: "/brand/og.png",
        width: 1200,
        height: 630,
        alt: "Longhorn Sim Racing",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: [
      {
        url: "/brand/og.png",
        width: 1200,
        height: 630,
        alt: "Longhorn Sim Racing",
      },
    ],
  },
  alternates: {
    types: {
      "application/rss+xml": "/news/rss.xml",
    }
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let user: Awaited<ReturnType<typeof getCachedSessionUser>>['user'] = null;
  let roles: string[] = [];
  let activeTierKey: string | null = null;

  try {
    const session = await getCachedSessionUser();
    user = session.user;
    roles = session.roles;

    if (user) {
      const activeMembership = await prisma.userMembership.findFirst({
        where: {
          userId: user.id,
          OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
        },
        include: { tier: { select: { key: true } } },
      });
      activeTierKey = activeMembership?.tier.key ?? null;
    }
  } catch (error) {
    console.warn('[RootLayout] Failed to load session/membership — rendering degraded shell:', error);
  }

  return (
    <html
      lang="en"
      className={`${montserrat.variable} ${kanit.variable} h-full dark`}
      style={{ colorScheme: "dark" }}
      suppressHydrationWarning
    >
    <body className="min-h-dvh flex flex-col font-sans">
    <ThemeProvider>
      <CartProvider>
        {/* <MaintenanceBanner /> */}
        <LiveBanner />
        <SiteHeader user={user} roles={roles} activeTierKey={activeTierKey} />
        <main className="flex-1">{children}</main>
        <SiteFooter />
        <Toaster position="bottom-right" />
        <RacingNumberPrompt userId={user?.id ?? null} hasRacingNumber={user?.racingNumber != null} />
      </CartProvider>
    </ThemeProvider>
    <Analytics />
    <SpeedInsights />
    </body>
    </html>
  )
}
