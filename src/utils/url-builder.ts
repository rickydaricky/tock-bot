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
 * Builds a Tock search URL with a specific date override
 * Used for cycling through fallback dates
 */
export function buildTockSearchUrlWithDate(
  baseUrl: string,
  preferences: TockPreferences,
  overrideDate: string
): string | null {
  try {
    const url = new URL(baseUrl);

    // Extract restaurant slug from pathname
    const pathParts = url.pathname.split('/').filter(p => p.length > 0);

    if (pathParts.length === 0) {
      console.error('Could not extract restaurant slug from URL:', baseUrl);
      return null;
    }

    const restaurantSlug = pathParts[0];

    // Validate date format (YYYY-MM-DD)
    if (!overrideDate || !/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
      console.error('Invalid date format:', overrideDate);
      return null;
    }

    // Format time as HH:MM
    const time = preferences.time;
    if (!time) {
      console.error('No time specified in preferences');
      return null;
    }

    // Build search URL with override date
    const searchUrl = new URL(`https://www.exploretock.com/${restaurantSlug}/search`);
    searchUrl.searchParams.set('date', overrideDate);
    searchUrl.searchParams.set('size', preferences.partySize.toString());
    searchUrl.searchParams.set('time', time);

    return searchUrl.toString();
  } catch (error) {
    console.error('Error building Tock search URL with date:', error);
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

/**
 * Builds a Resy venue URL with search params from preferences
 * Example: https://resy.com/cities/los-angeles-ca/venues/jeffs-inviting-food-and-spirits?date=2025-11-13&seats=2
 */
export function buildResySearchUrl(baseUrl: string, preferences: TockPreferences): string | null {
  try {
    const url = new URL(baseUrl);

    // Extract city and venue from pathname
    // e.g., "/cities/los-angeles-ca/venues/jeffs-inviting-food-and-spirits"
    const pathParts = url.pathname.split('/').filter(p => p.length > 0);

    // Check if URL has the expected structure: cities/{city}/venues/{venue}
    const citiesIndex = pathParts.indexOf('cities');
    const venuesIndex = pathParts.indexOf('venues');

    if (citiesIndex === -1 || venuesIndex === -1 || venuesIndex !== citiesIndex + 2) {
      console.error('Could not extract city and venue from Resy URL:', baseUrl);
      return null;
    }

    const citySlug = pathParts[citiesIndex + 1];
    const venueSlug = pathParts[venuesIndex + 1];

    // Validate date format
    const date = preferences.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error('Invalid date format in preferences:', date);
      return null;
    }

    // Build search URL
    const searchUrl = new URL(`https://resy.com/cities/${citySlug}/venues/${venueSlug}`);
    searchUrl.searchParams.set('date', date);
    searchUrl.searchParams.set('seats', preferences.partySize.toString());

    return searchUrl.toString();
  } catch (error) {
    console.error('Error building Resy search URL:', error);
    return null;
  }
}

/**
 * Builds a Resy venue URL with a specific date override
 * Used for cycling through fallback dates
 */
export function buildResySearchUrlWithDate(
  baseUrl: string,
  preferences: TockPreferences,
  overrideDate: string
): string | null {
  try {
    const url = new URL(baseUrl);

    // Extract city and venue from pathname
    const pathParts = url.pathname.split('/').filter(p => p.length > 0);

    // Check if URL has the expected structure
    const citiesIndex = pathParts.indexOf('cities');
    const venuesIndex = pathParts.indexOf('venues');

    if (citiesIndex === -1 || venuesIndex === -1 || venuesIndex !== citiesIndex + 2) {
      console.error('Could not extract city and venue from Resy URL:', baseUrl);
      return null;
    }

    const citySlug = pathParts[citiesIndex + 1];
    const venueSlug = pathParts[venuesIndex + 1];

    // Validate date format
    if (!overrideDate || !/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
      console.error('Invalid date format:', overrideDate);
      return null;
    }

    // Build search URL with override date
    const searchUrl = new URL(`https://resy.com/cities/${citySlug}/venues/${venueSlug}`);
    searchUrl.searchParams.set('date', overrideDate);
    searchUrl.searchParams.set('seats', preferences.partySize.toString());

    return searchUrl.toString();
  } catch (error) {
    console.error('Error building Resy search URL with date:', error);
    return null;
  }
}

/**
 * Checks if a URL is a Resy venue URL
 */
export function isResyVenueUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('resy.com') &&
           urlObj.pathname.includes('/cities/') &&
           urlObj.pathname.includes('/venues/');
  } catch {
    return false;
  }
}
