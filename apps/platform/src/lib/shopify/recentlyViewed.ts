import { Money } from "./types";

const STORAGE_KEY = "lsr_recently_viewed";
const MAX_ITEMS = 8;

export interface RecentProduct {
  handle: string;
  title: string;
  imageUrl: string;
  imageAlt: string;
  price: Money;
}

export function getRecentlyViewed(): RecentProduct[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function addRecentlyViewed(product: RecentProduct): void {
  if (typeof window === "undefined") return;
  try {
    const items = getRecentlyViewed();
    // Remove if already exists (we'll add to front)
    const filtered = items.filter((i) => i.handle !== product.handle);
    // Add to front and limit
    const updated = [product, ...filtered].slice(0, MAX_ITEMS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage errors
  }
}
