import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountDueCents } from '../src/booker';

// The single most safety-critical parse in the bot: it stands between "won the slot" and
// "charged the card". Every case here is a way it could under-read or false-match and let an
// over-cap charge through, OR fail to read and (correctly) abort.

test('parseAmountDueCents reads a plain grand total', () => {
  assert.equal(parseAmountDueCents('Amount due $250.00'), 25000);
});

test('parseAmountDueCents reads the TOTAL, not a "per person" line above it (C1)', () => {
  // "Amount due per person $125" must NOT match (no $ right after "due"); the grand total does.
  assert.equal(parseAmountDueCents('Amount due per person $125.00\nAmount due $250.00'), 25000);
});

test('parseAmountDueCents takes the largest when several "Amount due $" lines appear', () => {
  assert.equal(parseAmountDueCents('Subtotal Amount due $100.00 ... Amount due $250.00'), 25000);
});

test('parseAmountDueCents does NOT false-match non-currency text (C2)', () => {
  // No literal $ adjacent → no match → null → caller aborts (fail-closed).
  assert.equal(parseAmountDueCents('Amount due 50% deposit due now'), null);
});

test('parseAmountDueCents strips thousands separators', () => {
  assert.equal(parseAmountDueCents('Amount due $1,234.56'), 123456);
});

test('parseAmountDueCents bridges a newline between label and amount', () => {
  assert.equal(parseAmountDueCents('Amount due\n$839.00'), 83900);
});

test('parseAmountDueCents tolerates a colon and whole-dollar amounts', () => {
  assert.equal(parseAmountDueCents('Amount Due: $99'), 9900);
});

test('parseAmountDueCents returns null when no "Amount due $" is present', () => {
  assert.equal(parseAmountDueCents('Total $250.00'), null);
  assert.equal(parseAmountDueCents(''), null);
});

test('parseAmountDueCents reads a legitimate $0 total (free reservation)', () => {
  assert.equal(parseAmountDueCents('Amount due $0.00'), 0);
});
