import { cache } from 'react';
import {
  listAllEvents,
  listAllEventsForAdmin,
  getAllEventSeries as getAllEventSeriesFromRepo,
  getEventBySlug as getEventBySlugFromRepo,
  getEventById,
  listLiveEvents,
} from '@/server/repos/event.repo';

export const getAllEventsForAdmin = cache(async () => {
  return await listAllEventsForAdmin();
});

export const getEventForAdmin = cache(async (id: string) => {
  return await getEventById(id);
});

export const getAllEventSeries = cache(async () => {
  return await getAllEventSeriesFromRepo();
});

export const getEventBySlug = cache(async (slug: string) => {
  return await getEventBySlugFromRepo(slug);
});

export const getLiveEvents = cache(async () => {
  return await listLiveEvents();
});

export const getNextEventForHomepage = cache(async () => {
  const allEvents = await listAllEvents();
  const now = new Date();

  const upcoming = allEvents.filter(e => new Date(e.endsAtUtc) >= now);

  // The first event in the sorted list is the featured one.
  // It's either live or the next upcoming.
  return upcoming.slice(0, 5);
});
