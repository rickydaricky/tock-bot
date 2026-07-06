// server/src/opentable/url.ts
/** Extract the OpenTable restaurant slug from a bare slug or a full opentable.com URL. */
export function extractOpenTableSlug(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/opentable\.[a-z.]+\/r\/([^/?#]+)/i);
  if (m) return m[1];
  // Bare slug: strip any leading slash / query.
  return trimmed.replace(/^\/+/, '').split(/[?#]/)[0];
}

/** Build the OpenTable search/profile URL for a date/time/party. */
export function buildOpenTableSearchUrl(restaurant: string, date: string, time: string, partySize: number): string {
  const slug = extractOpenTableSlug(restaurant);
  const datetime = encodeURIComponent(`${date}T${time}`);
  return `https://www.opentable.com/r/${slug}?datetime=${datetime}&covers=${partySize}`;
}
