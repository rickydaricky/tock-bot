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
 * Key export: notifyResult().
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
