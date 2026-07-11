/**
 * notify.ts — Result notifications for the headless booking server.
 *
 * Single responsibility: fan out the outcome of a booking attempt (success or
 * failure) to an external webhook so operators get real-time alerts without
 * watching the server logs. This is the only place the server reaches out to a
 * notification sink.
 *
 * The payload is intentionally Slack-compatible: it sends a top-level `text`
 * field (which Slack renders directly as a message), while also including the
 * structured fields (`success`, `restaurant`, `date`, `time`, `error`,
 * `blitzMeta`) so non-Slack consumers can parse the raw data. A single webhook
 * URL therefore works for both Slack incoming webhooks and custom endpoints.
 *
 * Fire-and-forget by design: notification is a side effect, never on the
 * critical booking path, so a webhook failure is swallowed (logged, not thrown)
 * and never blocks or fails an otherwise-successful booking.
 *
 * Key exports: notifyResult() (booking outcome), notifyHeld() (high-urgency
 * alert the instant a lock is HELD, so a human can finish the modal checkout
 * inside the ~10-min hold — see the T0 Volley Fire spec's freeze-for-manual path).
 */
import { BookingResult } from './booker';

/**
 * Post a booking result to the configured webhook (Slack-compatible format).
 *
 * No-op when NOTIFY_WEBHOOK is unset — notifications are opt-in via env, so the
 * server runs fine without one. When set, the outcome is POSTed as JSON.
 *
 * @param restaurant  Human-readable restaurant name, used in the message text.
 * @param result      Booking outcome; `success` selects the ✅/❌ message and
 *                    supplies bookedDate/bookedTime (success) or error (failure).
 * @param blitzMeta   Optional blitz-mode stats. When `totalAttempted` is present
 *                    the message is annotated with "(attempt N/total)" so
 *                    operators can see which parallel attempt won the race.
 *
 * Never rejects: any fetch/network error is caught and logged so a failing
 * webhook cannot break the caller.
 */
export async function notifyResult(
  restaurant: string,
  result: BookingResult,
  blitzMeta?: { winningAttempt?: number; totalAttempted?: number },
): Promise<void> {
  const webhookUrl = process.env.NOTIFY_WEBHOOK;
  if (!webhookUrl) return;

  // Only annotate with attempt count in blitz mode (totalAttempted set). The
  // winning attempt number can be missing (e.g. on failure, no attempt won), so
  // fall back to '?' rather than printing "undefined".
  const blitzSuffix = blitzMeta?.totalAttempted
    ? ` (attempt ${blitzMeta.winningAttempt ?? '?'}/${blitzMeta.totalAttempted})`
    : '';

  const text = result.success
    ? `✅ Booked ${restaurant}: ${result.bookedDate}, ${result.bookedTime}${blitzSuffix}`
    : `❌ Booking failed for ${restaurant}: ${result.error}`;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        success: result.success,
        restaurant,
        date: result.bookedDate,
        time: result.bookedTime,
        error: result.error,
        blitzMeta,
      }),
    });
    console.log('📬 Notification sent');
  } catch (err) {
    // Swallow: a down/misconfigured webhook must not fail the booking flow.
    console.error('📬 Notification failed:', err);
  }
}

/**
 * Fire a HIGH-URGENCY alert the instant a lock is HELD (the first winning grab).
 *
 * FHH ships freeze-for-manual by design: the volley wins the ~10-min lock but a
 * human finishes the modal checkout. This alert exists to page that human the
 * moment the hold lands, with a one-click deeplink to the dashboard's Live
 * Sessions panel so they can complete the purchase inside the hold window.
 *
 * Reuses the same NOTIFY_WEBHOOK channel + Slack-compatible payload shape as
 * notifyResult(): a top-level `text` (rendered directly by Slack) plus the
 * structured fields (`held`, `urgent`, `restaurant`, `date`, `time`,
 * `dashboardUrl`) for non-Slack consumers.
 *
 * No-op when NOTIFY_WEBHOOK is unset — notifications stay opt-in via env, so a
 * missing channel is silent rather than an error. Never rejects: any
 * fetch/network error is caught and logged so a failing webhook can never
 * disrupt the critical claim path this fires from.
 *
 * @param restaurant    Human-readable restaurant name, used in the message text.
 * @param date          Booked date (e.g. the ISO/`YYYY-MM-DD` of the held cell).
 * @param time          Booked time (e.g. the 12h string of the held cell).
 * @param dashboardUrl  Optional one-click deeplink to the frozen session in the
 *                      dashboard. Falls back to `process.env.DASHBOARD_URL` when
 *                      omitted, and is left off the message when neither is set.
 */
export async function notifyHeld(
  restaurant: string,
  date: string,
  time: string,
  dashboardUrl?: string,
): Promise<void> {
  const webhookUrl = process.env.NOTIFY_WEBHOOK;
  if (!webhookUrl) return;

  // Prefer the caller-supplied deeplink; fall back to a configured dashboard URL
  // so the alert still links out when the caller doesn't have a session URL yet.
  const link = dashboardUrl ?? process.env.DASHBOARD_URL;
  const linkSuffix = link ? ` — finish checkout: ${link}` : '';

  // Leading 🚨 + "HELD" + "ACT NOW" cue a human that this is time-critical (the
  // ~10-min hold), distinct from the routine ✅/❌ booking-result messages.
  const text = `🚨 HELD ${restaurant}: ${date}, ${time} — ACT NOW (finish modal checkout within ~10 min)${linkSuffix}`;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        held: true,
        urgent: true,
        restaurant,
        date,
        time,
        dashboardUrl: link,
      }),
    });
    console.log('📬 HELD notification sent');
  } catch (err) {
    // Swallow: a down/misconfigured webhook must not disrupt the claim path.
    console.error('📬 HELD notification failed:', err);
  }
}
