import { BookingResult } from './booker';

/** Send booking result to a webhook (Slack-compatible format) */
export async function notifyResult(
  restaurant: string,
  result: BookingResult,
  blitzMeta?: { winningAttempt?: number; totalAttempted?: number },
): Promise<void> {
  const webhookUrl = process.env.NOTIFY_WEBHOOK;
  if (!webhookUrl) return;

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
    console.error('📬 Notification failed:', err);
  }
}
