import { Platform } from '../types';

/**
 * Detects which reservation platform a URL belongs to
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

  return null;
}

/**
 * Gets the display name for a platform
 */
export function getPlatformDisplayName(platform: Platform): string {
  switch (platform) {
    case 'tock':
      return 'Tock';
    case 'opentable':
      return 'OpenTable';
    default:
      return 'Unknown';
  }
}
