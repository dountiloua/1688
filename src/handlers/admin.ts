import { Bot, InlineKeyboard } from "grammy";
import {
  getFreightEstimate,
  getFxRate,
  getOrderById,
  isValidStatus,
  listAwaitingDeposit,
  setSetting,
  updateOrderStatus,
  type OrderStatus,
} from "../db.js";
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
            `🧾 ${o.titleRaw.slice(0, 80)}`,
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
          `🧾 ${o.titleRaw}`,
          `💴 ${o.priceRmb} RMB @ ${o.fxRateRmbDzd} DZD`,
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

  bot.command("setfx", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const arg = ctx.message?.text.split(/\s+/)[1];
    const rate = Number(arg);
    if (!arg || !Number.isFinite(rate) || rate <= 0 || rate > 1000) {
      await ctx.reply(
        `Usage: /setfx <rate>\nCurrent: ${getFxRate()} DZD per 1 CNY (new orders only).`,
      );
      return;
    }
    try {
      setSetting("fx_rate_rmb_dzd", String(rate));
      await ctx.reply(
        `✅ FX rate updated to ${rate} DZD/CNY for new orders. Existing orders unchanged.`,
      );
    } catch (err) {
      console.error("/setfx failed:", err);
      await ctx.reply("❌ Failed to update FX rate.");
    }
  });

  bot.command("setfreight", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const arg = ctx.message?.text.split(/\s+/)[1];
    const amount = Number(arg);
    if (!arg || !Number.isFinite(amount) || amount < 0 || amount > 10000000) {
      await ctx.reply(
        `Usage: /setfreight <amount_dzd>\nCurrent: ${formatDzd(getFreightEstimate())} (new orders only).`,
      );
      return;
    }
    try {
      setSetting("freight_estimate_dzd", String(Math.round(amount)));
      await ctx.reply(
        `✅ Freight estimate updated to ${formatDzd(amount)} for new orders.`,
      );
    } catch (err) {
      console.error("/setfreight failed:", err);
      await ctx.reply("❌ Failed to update freight estimate.");
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
