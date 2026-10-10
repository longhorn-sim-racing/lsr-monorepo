import "./globals.css"
import { Metadata, Viewport } from "next"
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
import { unstable_rethrow } from "next/navigation";
import { CANONICAL_SITE_URL } from "@/lib/site-url";

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
  metadataBase: new URL(CANONICAL_SITE_URL),
  manifest: "/manifest.json",
  keywords: [
    "sim racing",
    "UT Austin",
    "University of Texas",
    "Longhorn Sim Racing",
    "LSR",
    "esports",
    "student organization",
    "iRacing",
    "Assetto Corsa",
    "competitive racing",
    "Austin Texas",
    "Lone Star Cup",
  ],
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

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SportsOrganization",
  name: "Longhorn Sim Racing",
  alternateName: "LSR",
  url: CANONICAL_SITE_URL,
  logo: "https://www.longhornsimracing.org/brand/logos/black_logo_white_square.png",
  description:
    "UT Austin's premier sim racing organization. Events, drivers, race results, and championship series.",
  sport: "Sim Racing",
  parentOrganization: {
    "@type": "CollegeOrUniversity",
    name: "The University of Texas at Austin",
    url: "https://www.utexas.edu",
  },
  location: {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Austin",
      addressRegion: "TX",
      addressCountry: "US",
    },
  },
  email: "info@longhornsimracing.org",
  sameAs: [
    "https://discord.gg/5Uv9YwpnFz",
    "https://instagram.com/longhorn_sim_racing",
    "https://www.twitch.tv/longhorn_sim_racing",
    "https://www.linkedin.com/company/longhorn-sim-racing",
  ],
};

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
    // Next signals "render this page dynamically" (and redirects/notFound) by throwing; let those through
    unstable_rethrow(error);
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
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
    />
    <CartProvider>
      {/* <MaintenanceBanner /> */}
      <LiveBanner />
      <SiteHeader user={user} roles={roles} activeTierKey={activeTierKey} />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <Toaster position="bottom-right" />
      <RacingNumberPrompt userId={user?.id ?? null} hasRacingNumber={user?.racingNumber != null} />
    </CartProvider>
    <Analytics />
    <SpeedInsights />
    </body>
    </html>
  )
}
