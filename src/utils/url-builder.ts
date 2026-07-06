/**
 * url-builder.ts — Platform URL construction + recognition for the checkout content scripts.
 *
 * Single responsibility: given a restaurant's landing-page URL plus the user's
 * booking preferences, produce the canonical *search* URL for that platform (the
 * page that shows bookable slots), and provide predicates to recognize those URLs.
 *
 * Why this exists: the extension navigates from an arbitrary Tock/Resy page the
 * user is on to the platform's dedicated search view. Rather than hardcode URLs,
 * we derive the venue identity from whatever page the user pasted (its slug /
 * city+venue path) and re-emit a clean `/search` (Tock) or venue (Resy) URL with
 * `date`/`size`/`seats`/`time` query params the platform understands.
 *
 * Design invariants:
 *  - Every builder is total: it returns `null` (never throws) on any malformed
 *    input, so callers can branch on a single falsy check. All parsing runs inside
 *    try/catch because `new URL()` throws on invalid input.
 *  - The venue identity is extracted from `baseUrl`'s *path*, but the output host
 *    is always the canonical `www.exploretock.com` / `resy.com` — we never trust
 *    the input host for the emitted URL.
 *  - Dates are `YYYY-MM-DD`; times are `HH:MM` (24h) and rely on URLSearchParams
 *    to percent-encode the colon (e.g. `20:00` -> `20%3A00`).
 *
 * Key exports:
 *  - buildTockSearchUrl / buildTockSearchUrlWithDate — Tock search URLs.
 *  - buildResySearchUrl / buildResySearchUrlWithDate — Resy venue search URLs.
 *  - isTockSearchUrl / isResyVenueUrl — URL-shape predicates used to detect which
 *    platform page the extension is currently on.
 */

import { TockPreferences } from '../types';

/**
 * Builds a Tock search URL from the user's preferences (`date`/`time`/`partySize`).
 *
 * The restaurant slug is taken from the first path segment of `baseUrl` (whatever
 * Tock page the user is on), then re-hosted onto the canonical
 * `www.exploretock.com/{slug}/search` endpoint.
 *
 * Returns `null` (and logs) if the slug can't be extracted or `date`/`time` are
 * missing in preferences — callers treat `null` as "cannot build, skip".
 *
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

    // First non-empty path segment is the venue slug; anything deeper (menus,
    // experiences, etc.) is intentionally discarded — we only want the venue root.
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

    // Build search URL. Note the Tock-specific param names: `size` (party size)
    // and `time` (URLSearchParams encodes the colon in "HH:MM" as %3A).
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
 * Same as {@link buildTockSearchUrl}, but forces the date to `overrideDate`
 * instead of `preferences.date`.
 *
 * Used when cycling through fallback dates: the sniper/booker tries a sequence
 * of candidate dates while keeping the same venue/party-size/time. `overrideDate`
 * is strictly validated against `YYYY-MM-DD` (the plain builder trusts
 * `preferences.date`) to guard against malformed generated dates.
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
 * True if `url` is a Tock search page (host contains `exploretock.com` AND path
 * contains `/search`). Uses substring checks (not exact host) so subdomains and
 * locale-prefixed hosts still match. Returns `false` on any unparseable input.
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
 * Builds a Resy venue search URL from the user's preferences.
 *
 * Unlike Tock (single leading slug), Resy encodes venue identity as a
 * `cities/{city}/venues/{venue}` path, so we locate the `cities` and `venues`
 * markers and pull the segment after each. Party size is the `seats` param here
 * (Resy's spelling), and Resy has no `time` query param — the time is chosen on
 * the venue page itself, so it is intentionally omitted.
 *
 * Example: https://resy.com/cities/los-angeles-ca/venues/jeffs-inviting-food-and-spirits?date=2025-11-13&seats=2
 */
export function buildResySearchUrl(baseUrl: string, preferences: TockPreferences): string | null {
  try {
    const url = new URL(baseUrl);

    // Extract city and venue from pathname
    // e.g., "/cities/los-angeles-ca/venues/jeffs-inviting-food-and-spirits"
    const pathParts = url.pathname.split('/').filter(p => p.length > 0);

    // Require the exact `cities/{city}/venues/{venue}` shape: `venues` must sit
    // exactly two segments after `cities` (city slug in between). Rejecting any
    // other layout prevents emitting a wrong venue URL from an unexpected path.
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

    // Build search URL. `seats` (not `size`) is Resy's party-size param; no time param.
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
 * Same as {@link buildResySearchUrl}, but forces the date to `overrideDate`.
 *
 * Used when cycling through fallback dates (same venue/party-size, different
 * date). `overrideDate` is validated against `YYYY-MM-DD` here rather than being
 * taken from preferences.
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
 * True if `url` is a Resy venue page (host contains `resy.com` AND path contains
 * both `/cities/` and `/venues/`). Substring checks, so subdomains still match;
 * returns `false` on any unparseable input.
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

/**
 * True if `url` belongs to any OpenTable TLD variant (opentable.com,
 * opentable.co.uk, etc.). Checks only the hostname so any path/subpath matches;
 * returns `false` on any unparseable input.
 */
export function isOpenTableUrl(url: string): boolean {
  try { return /(^|\.)opentable\.[a-z.]+$/i.test(new URL(url).hostname); } catch { return false; }
}

/**
 * Extract the restaurant slug from an OpenTable `/r/<slug>` URL path.
 * Returns an empty string if the slug cannot be found (so callers always get a string).
 */
function openTableSlug(baseUrl: string): string {
  const m = baseUrl.match(/opentable\.[a-z.]+\/r\/([^/?#]+)/i);
  return m ? m[1] : '';
}

/**
 * Builds an OpenTable restaurant availability URL for a specific date.
 *
 * The venue slug is extracted from the `/r/<slug>` segment of `baseUrl`. The
 * `datetime` param combines `date` (YYYY-MM-DD) and `prefs.time` (HH:MM) in ISO
 * format, percent-encoded so the colon survives as `%3A`. `covers` carries the
 * party size.
 *
 * Example: https://www.opentable.com/r/nopa-san-francisco1?datetime=2026-07-19T19%3A00&covers=2
 */
export function buildOpenTableSearchUrlWithDate(baseUrl: string, prefs: { partySize: number; time: string }, date: string): string {
  const slug = openTableSlug(baseUrl);
  const datetime = encodeURIComponent(`${date}T${prefs.time}`);
  return `https://www.opentable.com/r/${slug}?datetime=${datetime}&covers=${prefs.partySize}`;
}

/**
 * Same as {@link buildOpenTableSearchUrlWithDate} but uses `prefs.date` as the
 * date. Convenience wrapper for the single-date / pre-navigation case where no
 * override date is needed.
 */
export function buildOpenTableSearchUrl(baseUrl: string, prefs: { partySize: number; time: string; date: string }): string {
  return buildOpenTableSearchUrlWithDate(baseUrl, prefs, prefs.date);
}
