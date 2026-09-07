/**
 * Private admin notifications via a DEDICATED Telegram bot.
 *
 * Order alerts, updates, anything admin-facing goes through NOTIFY_BOT_TOKEN
 * so the public customer bot never carries internal traffic.
 * Plain HTTPS sendMessage calls — no second polling instance needed.
 *
 * Returns true when the notification path was handled (sent or attempted
 * via the notify bot). Returns false only when no notify token is
 * configured, letting the caller fall back to the main bot.
 */
export async function notifyAdmin(text: string): Promise<boolean> {
  const token = (process.env.NOTIFY_BOT_TOKEN ?? "").trim();
  const chatId = (
    process.env.NOTIFY_CHAT_ID ??
    process.env.ADMIN_TELEGRAM_ID ??
    ""
  ).trim();
  if (!chatId) {
    console.warn("notifyAdmin: no NOTIFY_CHAT_ID / ADMIN_TELEGRAM_ID set");
    return true;
  }
  if (!token) return false;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `notify bot failed: HTTP ${res.status} ${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(
      "notify bot failed:",
      (err as Error)?.message ?? String(err),
    );
  }
  return true;
}
