// server/src/opentable/url.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { extractOpenTableSlug, buildOpenTableSearchUrl } from './url';

test('extractOpenTableSlug handles slug and full URL', () => {
  assert.equal(extractOpenTableSlug('nopa-san-francisco1'), 'nopa-san-francisco1');
  assert.equal(extractOpenTableSlug('https://www.opentable.com/r/nopa-san-francisco1'), 'nopa-san-francisco1');
  assert.equal(extractOpenTableSlug('https://www.opentable.com/r/nopa-san-francisco1?x=1'), 'nopa-san-francisco1');
});

test('buildOpenTableSearchUrl encodes datetime + covers', () => {
  const u = buildOpenTableSearchUrl('nopa-san-francisco1', '2026-07-19', '19:00', 2);
  assert.match(u, /^https:\/\/www\.opentable\.com\/r\/nopa-san-francisco1\?/);
  assert.match(u, /datetime=2026-07-19T19%3A00/);
  assert.match(u, /covers=2/);
});
