// src/utils/url-builder.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { buildOpenTableSearchUrlWithDate, isOpenTableUrl } from './url-builder';

test('isOpenTableUrl detects opentable hosts', () => {
  assert.equal(isOpenTableUrl('https://www.opentable.com/r/nopa-san-francisco1'), true);
  assert.equal(isOpenTableUrl('https://www.exploretock.com/nopa'), false);
});

test('buildOpenTableSearchUrlWithDate builds datetime+covers URL', () => {
  const u = buildOpenTableSearchUrlWithDate('https://www.opentable.com/r/nopa-san-francisco1', { partySize: 2, time: '19:00' } as any, '2026-07-19');
  assert.match(u, /opentable\.com\/r\/nopa-san-francisco1\?datetime=2026-07-19T19%3A00&covers=2/);
});
