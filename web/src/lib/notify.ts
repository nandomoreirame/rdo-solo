//! Best-effort Discord webhook notification. A failed alert must never crash the
//! monitor, so every error is swallowed.

export async function notifyDiscord(webhook: string, content: string): Promise<void> {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    // ignore: alerting is best-effort
  }
}
