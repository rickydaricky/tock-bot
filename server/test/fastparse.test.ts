import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOfferingsFromHtml, parseAvailability, experiencePriceCents } from '../src/sniper';

// Models the REAL $REDUX_STATE shape observed live (2026-06-30, Lazy Bear): the wider state
// embeds JS functions (e.g. "onClose":function…) so the whole literal can't be JSON.parsed,
// and the offerings subtree carries bare `undefined`. Strings contain stray braces. The parser
// must surgically extract only calendar.offerings and JSON-parse it.
const realisticHtml = (offeringsJsonish: string) =>
  `<!doctype html><html><head><script>window.$REDUX_STATE = {` +
  `"app":{"onClose":function noop(){ return {a:1}; },"label":"a } weird { string"},` +
  `"calendar":{"offerings":${offeringsJsonish}},` +
  `"trailing":undefined};</script></head><body>ok</body></html>`;

const offeringsLiteral =
  `{"openDate":["2026-07-29","2026-07-28"],` +
  `"openTime":["18:00","19:00"],` +
  `"experience":[{"id":546579,"state":"AVAILABLE","partySize":[2,3],` +
  `"name":"Chef } Table { Tasting","note":undefined,` +
  `"price":{"partyRangeConfigs":[{"ticketPriceInformation":{"amountCents":42000}}]}}]}`;

test('extractOfferingsFromHtml pulls calendar.offerings past embedded functions + string braces', () => {
  const off = extractOfferingsFromHtml(realisticHtml(offeringsLiteral));
  assert.ok(off, 'should extract offerings');
  assert.deepEqual(off.openDate, ['2026-07-29', '2026-07-28']);
  assert.deepEqual(off.openTime, ['18:00', '19:00']);
  assert.equal(off.experience[0].state, 'AVAILABLE');
  assert.equal(off.experience[0].name, 'Chef } Table { Tasting'); // braces inside string preserved
});

test('extractOfferingsFromHtml normalizes bare undefined to null (so JSON.parse succeeds)', () => {
  const off = extractOfferingsFromHtml(realisticHtml(offeringsLiteral));
  assert.equal(off.experience[0].note, null);
});

test('extracted offerings feed parseAvailability → full date×time cross-product with price', () => {
  const off = extractOfferingsFromHtml(realisticHtml(offeringsLiteral));
  const slots = parseAvailability(off, 2);
  assert.equal(slots.length, 4); // 2 dates × 2 times
  assert.equal(slots[0].priceCents, 42000);
  assert.equal(experiencePriceCents(off.experience[0]), 42000);
});

test('extractOfferingsFromHtml returns an empty-but-valid offerings object', () => {
  const off = extractOfferingsFromHtml(realisticHtml('{"openDate":[],"openTime":[],"experience":[]}'));
  assert.deepEqual(off, { openDate: [], openTime: [], experience: [] });
  assert.deepEqual(parseAvailability(off, 2), []);
});

test('extractOfferingsFromHtml returns null when the marker is absent', () => {
  assert.equal(extractOfferingsFromHtml('<html><body>no state here</body></html>'), null);
});

test('extractOfferingsFromHtml returns null when there is no offerings key', () => {
  const html = `<script>window.$REDUX_STATE = {"calendar":{"businessId":123},"x":undefined};</script>`;
  assert.equal(extractOfferingsFromHtml(html), null);
});

test('extractOfferingsFromHtml is not fooled by an "offerings" token inside an earlier string', () => {
  // A decoy "offerings": appears inside a string value before the real calendar.offerings.
  const html = `<script>window.$REDUX_STATE = {` +
    `"seo":{"blurb":"we list our \\"offerings\\": small plates"},` +
    `"calendar":{"offerings":{"openDate":["2026-08-01"],"openTime":["20:00"],` +
    `"experience":[{"id":7,"state":"AVAILABLE","partySize":[2]}]}}};</script>`;
  const off = extractOfferingsFromHtml(html);
  assert.ok(off);
  assert.deepEqual(off.openDate, ['2026-08-01']);
});
