import { Bot, InlineKeyboard } from "grammy";
import {
  getFreightPerKg,
  getOrderById,
  getUsdRate,
  isValidStatus,
  listAwaitingDeposit,
  setSetting,
  updateOrderStatus,
  type OrderStatus,
} from "../db.js";
import { getCnyMode, getCnyPerUsd } from "../fx.js";
import { formatDzd } from "../i18n.js";
import type { MyContext } from "../session.js";

function isAdmin(ctx: MyContext): boolean {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminId) return false;
  return String(ctx.from?.id) === String(adminId).trim();
}

async function requireAdmin(ctx: MyContext): Promise<boolean> {
  if (isAdmin(ctx)) return true;
  try {
    await ctx.reply("⛔ Unauthorized.");
  } catch {
    // ignore
  }
  return false;
}

export function registerAdminHandlers(bot: Bot<MyContext>): void {
  bot.command("orders", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    try {
      const orders = listAwaitingDeposit(20);
      if (orders.length === 0) {
        await ctx.reply("📭 No orders awaiting deposit.");
        return;
      }
      for (const o of orders) {
        const kb = new InlineKeyboard().text(
          `✅ Mark #${o.id} DEPOSIT_PAID`,
          `deposit:${o.id}`,
        );
        await ctx.reply(
          [
            `#${o.id} • ${o.shippingMark || "no mark yet"}`,
            `👤 ${o.fullName} • ${o.phone}`,
            `📍 ${o.wilaya}`,
            `🧾 ${o.titleRaw.slice(0, 80)} ×${o.quantity || 1}`,
            `💰 ${formatDzd(o.totalAmountDzd)} (deposit ${formatDzd(o.depositAmountDzd)})`,
            `🔗 ${o.productUrl}`,
          ].join("\n"),
          { reply_markup: kb },
        );
      }
    } catch (err) {
      console.error("/orders failed:", err);
      await ctx.reply("❌ Failed to list orders.");
    }
  });

  bot.callbackQuery(/^deposit:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) {
      await ctx.answerCallbackQuery("Unauthorized").catch(() => undefined);
      return;
    }
    const id = Number(ctx.match[1]);
    try {
      const order = getOrderById(id);
      if (!order) {
        await ctx.answerCallbackQuery(`Order #${id} not found`);
        return;
      }
      const updated = updateOrderStatus(id, "DEPOSIT_PAID");
      await ctx.answerCallbackQuery(`#${id} → DEPOSIT_PAID`);
      await ctx.reply(`✅ Order #${id} marked as DEPOSIT_PAID.`);
      if (updated) {
        try {
          await ctx.api.sendMessage(
            updated.telegramUserId,
            `✅ تم تأكيد العربون لطلبك #${id}!\n📌 الحالة الجديدة: DEPOSIT_PAID\n🏷️ Shipping Mark: ${updated.shippingMark}`,
          );
        } catch (notifyErr) {
          console.error("customer notify failed:", notifyErr);
        }
      }
    } catch (err) {
      console.error("deposit callback failed:", err);
      await ctx.answerCallbackQuery("Failed").catch(() => undefined);
    }
  });

  bot.command("order", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const arg = ctx.message?.text.split(/\s+/)[1];
    const id = Number(arg);
    if (!arg || !Number.isInteger(id) || id <= 0) {
      await ctx.reply("Usage: /order <id>");
      return;
    }
    try {
      const o = getOrderById(id);
      if (!o) {
        await ctx.reply(`Order #${id} not found.`);
        return;
      }
      await ctx.reply(
        [
          `🧾 Order #${o.id} • ${o.status}`,
          `👤 ${o.fullName} • ${o.phone}`,
          `📍 ${o.wilaya} — ${o.address}`,
          `🧾 ${o.titleRaw} ×${o.quantity || 1}`,
          `💴 ${o.priceRmb} RMB / unit`,
          o.weightKg > 0
            ? `⚖️ ${o.weightKg} kg → freight ${formatDzd(o.freightDzd)}`
            : `⚖️ Weight unknown → freight TBD`,
          `💰 Total ${formatDzd(o.totalAmountDzd)} • Deposit ${formatDzd(o.depositAmountDzd)} • Rest ${formatDzd(o.remainingBalanceDzd)}`,
          `HK Shipping / Mark: ${o.shippingMark}`,
          `🔗 ${o.productUrl}`,
          `🕒 ${o.createdAt}`,
        ].join("\n"),
      );
    } catch (err) {
      console.error("/order failed:", err);
      await ctx.reply("❌ Failed to load order.");
    }
  });

  bot.command("setusd", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const arg = ctx.message?.text.split(/\s+/)[1];
    const rate = Number(arg);
    if (!arg || !Number.isFinite(rate) || rate <= 0 || rate > 10000) {
      await ctx.reply(
        `Usage: /setusd <rate_dzd_per_usd>\nCurrent: ${getUsdRate()} DZD per 1 USD (new orders only).`,
      );
      return;
    }
    try {
      setSetting("usd_rate_dzd", String(rate));
      await ctx.reply(
        `✅ USD rate updated to ${rate} DZD/USD for new orders. Existing orders unchanged.`,
      );
    } catch (err) {
      console.error("/setusd failed:", err);
      await ctx.reply("❌ Failed to update USD rate.");
    }
  });

  bot.command("setcny", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const arg = (ctx.message?.text.split(/\s+/)[1] ?? "").toLowerCase();
    try {
      if (arg === "auto") {
        setSetting("cny_per_usd_mode", "auto");
        const live = await getCnyPerUsd();
        await ctx.reply(
          `✅ CNY→USD back to AUTO (live: ${live.rate.toFixed(4)} CNY per USD, cached 12h).`,
        );
        return;
      }
      const rate = Number(arg);
      if (!arg || !Number.isFinite(rate) || rate < 5 || rate > 12) {
        const cur = await getCnyPerUsd().catch(() => null);
        await ctx.reply(
          `Usage: /setcny auto | /setcny <rate_cny_per_usd>\nMode: ${getCnyMode()}${cur ? ` • current: ${cur.rate.toFixed(4)} (${cur.source})` : ""}`,
        );
        return;
      }
      setSetting("cny_per_usd_mode", "manual");
      setSetting("cny_per_usd_manual", String(rate));
      await ctx.reply(
        `✅ CNY→USD set manually to ${rate} (panel + bot use this until you /setcny auto).`,
      );
    } catch (err) {
      console.error("/setcny failed:", err);
      await ctx.reply("❌ Failed to update CNY rate.");
    }
  });

  bot.command("setfreightkg", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const arg = ctx.message?.text.split(/\s+/)[1];
    const amount = Number(arg);
    if (!arg || !Number.isFinite(amount) || amount < 0 || amount > 10000000) {
      await ctx.reply(
        `Usage: /setfreightkg <amount_dzd_per_kg>\nCurrent: ${formatDzd(getFreightPerKg())} / kg (new orders only).`,
      );
      return;
    }
    try {
      setSetting("freight_per_kg_dzd", String(Math.round(amount)));
      await ctx.reply(
        `✅ Freight updated to ${formatDzd(amount)} per kg for new orders.`,
      );
    } catch (err) {
      console.error("/setfreightkg failed:", err);
      await ctx.reply("❌ Failed to update freight rate.");
    }
  });

  bot.command("rates", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    try {
      const cny = await getCnyPerUsd();
      await ctx.reply(
        [
          `💱 Current pricing inputs (new orders):`,
          `• CNY→USD: ${cny.rate.toFixed(4)} (${cny.source}, mode ${getCnyMode()})`,
          `• USD→DZD: ${getUsdRate()}`,
          `• Freight: ${formatDzd(getFreightPerKg())} / kg`,
        ].join("\n"),
      );
    } catch (err) {
      console.error("/rates failed:", err);
      await ctx.reply("❌ Could not load rates.");
    }
  });

  bot.command("advance", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const parts = (ctx.message?.text ?? "").split(/\s+/);
    const id = Number(parts[1]);
    const newStatus = parts[2];
    if (!parts[1] || !Number.isInteger(id) || id <= 0 || !newStatus) {
      await ctx.reply(
        "Usage: /advance <order_id> <new_status>\nStatuses: AWAITING_DEPOSIT, DEPOSIT_PAID, FORWARDED_TO_SHIPPING_PARTNER, IN_TRANSIT, DELIVERED, CANCELLED",
      );
      return;
    }
    if (!isValidStatus(newStatus)) {
      await ctx.reply(`❌ Unknown status "${newStatus}".`);
      return;
    }
    try {
      const order = getOrderById(id);
      if (!order) {
        await ctx.reply(`Order #${id} not found.`);
        return;
      }
      const updated = updateOrderStatus(id, newStatus as OrderStatus);
      await ctx.reply(`✅ Order #${id} → ${newStatus}`);
      if (updated) {
        try {
          await ctx.api.sendMessage(
            updated.telegramUserId,
            `📌 تحديث طلبك #${id}: الحالة الجديدة ${newStatus}\n🏷️ ${updated.shippingMark}`,
          );
        } catch (notifyErr) {
          console.error("customer notify failed:", notifyErr);
          await ctx.reply("⚠️ Status updated but customer notification failed.");
        }
      }
    } catch (err) {
      console.error("/advance failed:", err);
      await ctx.reply("❌ Failed to update order.");
    }
  });
}
