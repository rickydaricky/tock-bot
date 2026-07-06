// server/src/cookies.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { updateCookies, getCookies } from './cookies';

test('cookies are stored per platform and do not cross-contaminate', () => {
  updateCookies([{ name: 't', value: '1', domain: '.exploretock.com', path: '/' }], 'tock');
  updateCookies([{ name: 'o', value: '2', domain: '.opentable.com', path: '/' }], 'opentable');
  assert.equal(getCookies('tock').length, 1);
  assert.equal(getCookies('tock')[0].name, 't');
  assert.equal(getCookies('opentable').length, 1);
  assert.equal(getCookies('opentable')[0].name, 'o');
});

test('getCookies defaults to tock (back-compat)', () => {
  updateCookies([{ name: 't', value: '1', domain: '.exploretock.com', path: '/' }]);
  assert.equal(getCookies().length, 1);
});
