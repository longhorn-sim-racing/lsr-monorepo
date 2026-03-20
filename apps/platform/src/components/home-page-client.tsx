"use client"

import Hero from "@/components/home/Hero"
import NextEvent from "@/components/home/NextEvent"
import WhatWeDo from "@/components/home/WhatWeDo"
import Leaderboard from "@/components/home/Leaderboard"
import Hotlap from "@/components/home/Hotlap"
import SponsorStrip from "@/components/home/SponsorStrip"
import NewsHighlights from "@/components/home/NewsHighlights"
import GalleryRibbon from "@/components/home/GalleryRibbon"
import FinalCta from "@/components/home/FinalCta"
import { type NewsFrontmatter } from '@/lib/news';
import { type User, type Event, type Venue, type EventSeries, type GalleryImage } from '@prisma/client';
import type { HotlapSettings } from '@/lib/email/settings';

type DriverWithPoints = User & { allTimePoints: number };

type Props = {
  posts: Array<NewsFrontmatter & { slug: string }>;
  featuredEvent?: Event & { venue: Venue | null, series: EventSeries | null };
  upcomingEvents: (Event & { venue: Venue | null, series: EventSeries | null })[];
  drivers: DriverWithPoints[];
  galleryImages: GalleryImage[];
  hotlap?: HotlapSettings | null;
}

export default function HomePageClient({ posts, featuredEvent, upcomingEvents, drivers, galleryImages, hotlap }: Props) {
  return (
    <main className="relative bg-lsr-charcoal text-white">
      <Hero />

      {/* Below-hero content */}
      <div className="space-y-10 md:space-y-14 px-6 md:px-8 pb-10 md:pb-14">
        <WhatWeDo index={0} />
        <NextEvent index={1} featuredEvent={featuredEvent} upcomingEvents={upcomingEvents} />
        <Leaderboard index={2} drivers={drivers} />
        <Hotlap index={3} hotlap={hotlap} />
        <NewsHighlights index={4} posts={posts} />
        <FinalCta index={5} />
        <SponsorStrip index={6} />
        <GalleryRibbon index={7} galleryImages={galleryImages} />
      </div>
    </main>
  )
}