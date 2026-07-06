/**
 * platform.ts — Reservation-platform detection from a page URL.
 *
 * Single responsibility: map an arbitrary URL to one of the three supported
 * reservation platforms (Tock / OpenTable / Resy), or `null` when none match.
 * This is the routing primitive the Chrome extension uses to decide which
 * content-script form-filler applies to the current page
 * (`content/form-filler.ts` for Tock, `opentable-form-filler.ts`,
 * `resy-form-filler.ts`), and to label platforms in the popup/timer UI.
 *
 * Detection is intentionally hostname-substring based (not a strict URL parse)
 * so it works on any page/subpath of a platform without maintaining an
 * exhaustive route list. It stays purely functional and side-effect free so it
 * can run in both the service worker and content-script contexts.
 *
 * Key exports:
 *   - detectPlatform(url)            → Platform | null  (which platform a URL belongs to)
 *   - getPlatformDisplayName(platform) → human-facing label for UI
 */

import { Platform } from '../types';

/**
 * Detects which reservation platform a URL belongs to by matching known host
 * substrings, returning `null` if the URL is on no supported platform.
 *
 * Notes / gotchas:
 * - Matching is case-insensitive (URL is lowercased first) and substring-based,
 *   so it matches any subdomain/path (e.g. `www.exploretock.com/foo`) without
 *   parsing the URL.
 * - OpenTable is matched against a long list of per-country TLDs (.com, .co.uk,
 *   .ca, .jp, .de, ...) because OpenTable serves each locale on a distinct
 *   ccTLD rather than a single domain — Tock and Resy each use one domain.
 */
export function detectPlatform(url: string): Platform | null {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('exploretock.com')) {
    return 'tock';
  }

  if (urlLower.includes('opentable.com') ||
      urlLower.includes('opentable.co.uk') ||
      urlLower.includes('opentable.ca') ||
      urlLower.includes('opentable.jp') ||
      urlLower.includes('opentable.de') ||
      urlLower.includes('opentable.es') ||
      urlLower.includes('opentable.fr') ||
      urlLower.includes('opentable.it') ||
      urlLower.includes('opentable.nl') ||
      urlLower.includes('opentable.com.au') ||
      urlLower.includes('opentable.com.mx') ||
      urlLower.includes('opentable.ie') ||
      urlLower.includes('opentable.sg') ||
      urlLower.includes('opentable.hk') ||
      urlLower.includes('opentable.ae') ||
      urlLower.includes('opentable.co.th') ||
      urlLower.includes('opentable.com.tw')) {
    return 'opentable';
  }

  if (urlLower.includes('resy.com')) {
    return 'resy';
  }

  return null;
}

/**
 * Maps a Platform value to its human-facing display label (e.g. 'tock' → 'Tock')
 * for use in the popup and floating-timer UI.
 *
 * The `default` branch is unreachable given the current `Platform` union, but is
 * kept as a defensive fallback so a future platform added to the type without
 * updating this switch degrades to 'Unknown' rather than returning undefined.
 */
export function getPlatformDisplayName(platform: Platform): string {
  switch (platform) {
    case 'tock':
      return 'Tock';
    case 'opentable':
      return 'OpenTable';
    case 'resy':
      return 'Resy';
    default:
      return 'Unknown';
  }
}
