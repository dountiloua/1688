import "dotenv/config";
import { Bot, session } from "grammy";
import { getDb } from "./db.js";
import { startDashboard } from "./dashboard.js";
import { registerAdminHandlers } from "./handlers/admin.js";
import { registerCustomerHandlers } from "./handlers/customer.js";
import { closeScraper } from "./scraper/oneSixEightEight.js";
import { initialSession, type MyContext } from "./session.js";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(
      "Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.",
    );
    process.exit(1);
  }
  if (!process.env.ADMIN_TELEGRAM_ID) {
    console.warn(
      "Warning: ADMIN_TELEGRAM_ID is not set — admin commands will reject everyone.",
    );
  }

  // Init DB (creates file + tables). SQLite path comes from DATABASE_PATH.
  try {
    getDb();
    console.log(
      `SQLite ready at ${process.env.DATABASE_PATH ?? "./data/orders.db"}`,
    );
  } catch (err) {
    console.error("Failed to initialise SQLite:", err);
    process.exit(1);
  }

  const bot = new Bot<MyContext>(token);

  bot.use(session({ initial: initialSession }));
  registerCustomerHandlers(bot);
  registerAdminHandlers(bot);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
    const ctx = err.ctx;
    ctx
      .reply("❌ حدث خطأ غير متوقع. حاول مجدداً.")
      .catch(() => undefined);
  });

  // Admin web panel (+ /health endpoint) for Railway (expects $PORT bound).
  const port = Number(process.env.PORT ?? 3000);
  const server = startDashboard(bot, port);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await bot.stop();
    } catch {
      // ignore
    }
    await closeScraper();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);
  console.log("Starting long polling...");
  await bot.start();
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
