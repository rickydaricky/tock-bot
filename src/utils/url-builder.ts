import { TockPreferences } from '../types';

/**
 * Builds a Tock search URL from preferences
 * Example: https://www.exploretock.com/fui-hui-hua-san-francisco/search?date=2025-11-07&size=2&time=20%3A00
 */
export function buildTockSearchUrl(baseUrl: string, preferences: TockPreferences): string | null {
  try {
    const url = new URL(baseUrl);

    // Extract restaurant slug from pathname
    // e.g., "/fui-hui-hua-san-francisco/" -> "fui-hui-hua-san-francisco"
    const pathParts = url.pathname.split('/').filter(p => p.length > 0);

    if (pathParts.length === 0) {
      console.error('Could not extract restaurant slug from URL:', baseUrl);
      return null;
    }

    const restaurantSlug = pathParts[0];

    // Format date as YYYY-MM-DD
    const date = preferences.date;
    if (!date) {
      console.error('No date specified in preferences');
      return null;
    }

    // Format time as HH:MM (already in this format from preferences)
    const time = preferences.time;
    if (!time) {
      console.error('No time specified in preferences');
      return null;
    }

    // Build search URL
    const searchUrl = new URL(`https://www.exploretock.com/${restaurantSlug}/search`);
    searchUrl.searchParams.set('date', date);
    searchUrl.searchParams.set('size', preferences.partySize.toString());
    searchUrl.searchParams.set('time', time);

    return searchUrl.toString();
  } catch (error) {
    console.error('Error building Tock search URL:', error);
    return null;
  }
}

/**
 * Checks if a URL is a Tock search URL
 */
export function isTockSearchUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('exploretock.com') &&
           urlObj.pathname.includes('/search');
  } catch {
    return false;
  }
}
