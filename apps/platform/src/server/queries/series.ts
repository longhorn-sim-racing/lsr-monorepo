import { cache } from 'react';
import {
  listAllSeries,
  getSeriesById,
} from '@/server/repos/series.repo';

export const getAllSeries = cache(async () => {
  return await listAllSeries();
});

export const getSeries = cache(async (id: string) => {
  return await getSeriesById(id);
});