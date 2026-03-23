import { BookingResult } from './booker';

/** Send booking result to a webhook (Slack-compatible format) */
export async function notifyResult(restaurant: string, result: BookingResult): Promise<void> {
  const webhookUrl = process.env.NOTIFY_WEBHOOK;
  if (!webhookUrl) return;

  const text = result.success
    ? `✅ Booked ${restaurant}: ${result.bookedDate}, ${result.bookedTime}`
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
      }),
    });
    console.log('📬 Notification sent');
  } catch (err) {
    console.error('📬 Notification failed:', err);
  }
}
