import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyHeld } from '../src/notify';

// notifyHeld() pages a human the instant a lock is HELD so they can finish the modal
// checkout inside the ~10-min hold. It fires from the critical claim path, so the two
// invariants that matter most are: (1) it is a no-op / never throws when unconfigured,
// and (2) it never throws even when the webhook fetch rejects. The payload-shape tests
// guard the Slack-compatible contract downstream consumers rely on.

/**
 * Run `fn` with a stubbed global fetch + a controlled env, restoring both after.
 * Returns the single request captured by the stub (or null if fetch was never called).
 */
async function withFetch(
  env: { NOTIFY_WEBHOOK?: string; DASHBOARD_URL?: string },
  impl: (url: string, init: RequestInit) => Promise<unknown>,
  fn: () => Promise<void>,
): Promise<{ url: string; init: RequestInit } | null> {
  const origFetch = globalThis.fetch;
  const origWebhook = process.env.NOTIFY_WEBHOOK;
  const origDashboard = process.env.DASHBOARD_URL;

  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return impl(url, init);
  }) as unknown as typeof fetch;

  if (env.NOTIFY_WEBHOOK === undefined) delete process.env.NOTIFY_WEBHOOK;
  else process.env.NOTIFY_WEBHOOK = env.NOTIFY_WEBHOOK;
  if (env.DASHBOARD_URL === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = env.DASHBOARD_URL;

  try {
    await fn();
    return captured;
  } finally {
    globalThis.fetch = origFetch;
    if (origWebhook === undefined) delete process.env.NOTIFY_WEBHOOK;
    else process.env.NOTIFY_WEBHOOK = origWebhook;
    if (origDashboard === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = origDashboard;
  }
}

/** Parse the JSON body a captured request POSTed. */
function body(captured: { init: RequestInit } | null): Record<string, unknown> {
  assert.ok(captured, 'expected fetch to have been called');
  return JSON.parse(captured!.init.body as string);
}

test('notifyHeld is a no-op when NOTIFY_WEBHOOK is unset (never fetches)', async () => {
  const captured = await withFetch(
    { NOTIFY_WEBHOOK: undefined },
    async () => {
      throw new Error('fetch must not be called when unconfigured');
    },
    async () => {
      await notifyHeld('FHH', '2026-07-17', '8:00 PM', 'https://dash/session/1');
    },
  );
  assert.equal(captured, null);
});

test('notifyHeld POSTs a high-urgency, Slack-compatible payload to the webhook', async () => {
  const captured = await withFetch(
    { NOTIFY_WEBHOOK: 'https://hook.example/slack' },
    async () => ({ ok: true }),
    async () => {
      await notifyHeld('FHH', '2026-07-17', '8:00 PM', 'https://dash/session/1');
    },
  );
  assert.ok(captured);
  assert.equal(captured!.url, 'https://hook.example/slack');
  assert.equal(captured!.init.method, 'POST');

  const b = body(captured);
  assert.equal(b.held, true);
  assert.equal(b.urgent, true);
  assert.equal(b.restaurant, 'FHH');
  assert.equal(b.date, '2026-07-17');
  assert.equal(b.time, '8:00 PM');
  assert.equal(b.dashboardUrl, 'https://dash/session/1');
  // The rendered text carries the restaurant, cell, an act-now cue, and the deeplink.
  assert.match(b.text as string, /HELD FHH/);
  assert.match(b.text as string, /2026-07-17, 8:00 PM/);
  assert.match(b.text as string, /ACT NOW/);
  assert.match(b.text as string, /https:\/\/dash\/session\/1/);
});

test('notifyHeld prefers the caller-supplied dashboardUrl over DASHBOARD_URL', async () => {
  const captured = await withFetch(
    { NOTIFY_WEBHOOK: 'https://hook', DASHBOARD_URL: 'https://env-dash' },
    async () => ({ ok: true }),
    async () => {
      await notifyHeld('FHH', '2026-07-17', '8:00 PM', 'https://arg-dash/session/9');
    },
  );
  const b = body(captured);
  assert.equal(b.dashboardUrl, 'https://arg-dash/session/9');
  assert.match(b.text as string, /https:\/\/arg-dash\/session\/9/);
});

test('notifyHeld falls back to DASHBOARD_URL when no arg is given', async () => {
  const captured = await withFetch(
    { NOTIFY_WEBHOOK: 'https://hook', DASHBOARD_URL: 'https://env-dash/live' },
    async () => ({ ok: true }),
    async () => {
      await notifyHeld('FHH', '2026-07-17', '8:00 PM');
    },
  );
  const b = body(captured);
  assert.equal(b.dashboardUrl, 'https://env-dash/live');
  assert.match(b.text as string, /https:\/\/env-dash\/live/);
});

test('notifyHeld omits the link cleanly when neither arg nor env is set', async () => {
  const captured = await withFetch(
    { NOTIFY_WEBHOOK: 'https://hook', DASHBOARD_URL: undefined },
    async () => ({ ok: true }),
    async () => {
      await notifyHeld('FHH', '2026-07-17', '8:00 PM');
    },
  );
  const b = body(captured);
  assert.equal(b.dashboardUrl, undefined);
  // No trailing "finish checkout:" suffix, and no literal "undefined" in the text.
  assert.doesNotMatch(b.text as string, /finish checkout:/);
  assert.doesNotMatch(b.text as string, /undefined/);
});

test('notifyHeld swallows a fetch rejection (never throws on the claim path)', async () => {
  await withFetch(
    { NOTIFY_WEBHOOK: 'https://hook' },
    async () => {
      throw new Error('network down');
    },
    async () => {
      // Must resolve, not reject — a failing webhook cannot disrupt the grab.
      await notifyHeld('FHH', '2026-07-17', '8:00 PM', 'https://dash/1');
    },
  );
});
