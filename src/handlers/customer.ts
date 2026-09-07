import { Bot, InlineKeyboard } from "grammy";
import {
  createOrder,
  getFreightPerKg,
  getUsdRate,
  listOrdersByUser,
} from "../db.js";
import { getCnyPerUsd } from "../fx.js";
import { formatDzd, t } from "../i18n.js";
import {
  is1688Url,
  Product1688ScrapeError,
  scrape1688Product,
} from "../scraper/index.js";
import { quotePrice } from "../pricing.js";
import type { MyContext, PendingProduct } from "../session.js";

const URL_RE = /https?:\/\/[^\s]+/gi;

function extract1688Url(text: string): string | null {
  const matches = text.match(URL_RE);
  if (!matches) return null;
  for (const m of matches) {
    const cleaned = m.replace(/[)\].,;!؟،]+$/u, "");
    if (is1688Url(cleaned)) return cleaned;
  }
  return null;
}

function productCaption(
  p: PendingProduct,
  freightPerKg: number,
): string {
  // Customer sees: RMB price → DZD price → shipping estimate → total later.
  // Exchange-rate internals (USD leg) stay hidden on purpose.
  const lines = [
    `🧾 ${p.title}`,
    ``,
    `💴 السعر: ${p.priceRmb} RMB`,
    `💰 السعر بالدينار (للقطعة): ${formatDzd(p.unitDzd)}`,
    `🚚 الشحن التقديري: ${formatDzd(freightPerKg)} لكل 1kg`,
    p.moq !== null ? `📦 أقل كمية للطلب (MOQ): ${p.moq}` : null,
    ``,
    `🔗 ${p.url}`,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

export function registerCustomerHandlers(bot: Bot<MyContext>): void {
  bot.command("start", async (ctx) => {
    ctx.session.step = "idle";
    ctx.session.pending = null;
    await ctx.reply(t(ctx.session.lang, "welcome"));
  });

  bot.command("lang", async (ctx) => {
    const kb = new InlineKeyboard()
      .text("العربية", "lang:ar")
      .text("Français", "lang:fr")
      .text("English", "lang:en");
    await ctx.reply(t(ctx.session.lang, "chooseLang"), {
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^lang:(ar|fr|en)$/, async (ctx) => {
    const lang = ctx.match[1] as "ar" | "fr" | "en";
    ctx.session.lang = lang;
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "langSet"));
  });

  bot.command("cancel", async (ctx) => {
    ctx.session.step = "idle";
    ctx.session.pending = null;
    await ctx.reply(t(ctx.session.lang, "cancelled"));
  });

  bot.command("myorders", async (ctx) => {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;
      const orders = listOrdersByUser(userId, 20);
      if (orders.length === 0) {
        await ctx.reply(t(ctx.session.lang, "noOrders"));
        return;
      }
      const lines = orders.map(
        (o) =>
          `#${o.id} • ${o.status}\n${o.titleRaw.slice(0, 60)} ×${o.quantity || 1}\n${formatDzd(o.totalAmountDzd)} • ${o.shippingMark}`,
      );
      await ctx.reply(`📦 طلباتك:\n\n${lines.join("\n\n")}`);
    } catch (err) {
      console.error("myorders failed:", err);
      await ctx.reply("❌ حدث خطأ أثناء جلب طلباتك. حاول مجدداً.");
    }
  });

  // Confirm / cancel buttons on the product preview
  bot.callbackQuery("product:confirm", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const pending = ctx.session.pending;
      if (!pending) {
        await ctx.reply(t(ctx.session.lang, "sessionExpired"));
        return;
      }
      ctx.session.step = "awaiting_quantity";
      let q = t(ctx.session.lang, "askQuantity");
      if (pending.moq !== null && pending.moq > 1) {
        q += `\n📦 أقل كمية للطلب (MOQ): ${pending.moq}`;
      }
      await ctx.reply(q);
    } catch (err) {
      console.error("confirm failed:", err);
      await ctx.reply("❌ حدث خطأ. حاول مجدداً.");
    }
  });

  bot.callbackQuery("product:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.step = "idle";
    ctx.session.pending = null;
    await ctx.reply(t(ctx.session.lang, "cancelled"));
  });

  // Main message handler: conversation steps first, then 1688 links
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const lang = ctx.session.lang;

    // Ignore other commands (let command handlers deal with them)
    if (text.startsWith("/")) return;

    try {
      // --- In-progress order conversation ---
      switch (ctx.session.step) {
        case "awaiting_quantity": {
          const qty = Math.floor(Number(text.replace(/,/g, "")));
          const moq = ctx.session.pending?.moq ?? null;
          const minQty = moq !== null && moq > 1 ? moq : 1;
          if (!Number.isFinite(qty) || qty < minQty || qty > 1000000) {
            let msg = t(lang, "askQuantityInvalid");
            if (minQty > 1) msg += ` (أقل كمية: ${minQty})`;
            await ctx.reply(msg);
            return;
          }
          ctx.session.draftQuantity = qty;
          ctx.session.step = "awaiting_weight";
          await ctx.reply(
            t(lang, "askWeight").replace(
              "{FREIGHT}",
              Math.round(getFreightPerKg()).toLocaleString("en-US"),
            ),
          );
          return;
        }
        case "awaiting_weight": {
          const normalized = text.replace(/,/g, "").trim();
          const unknown =
            normalized === "0" ||
            normalized === "?" ||
            /لا\s?أعرف|لا اعرف|unknown|dont know/i.test(normalized);
          const w = unknown ? 0 : Number(normalized);
          if (!unknown && (!Number.isFinite(w) || w < 0 || w > 100000)) {
            await ctx.reply(t(lang, "askWeightInvalid"));
            return;
          }
          ctx.session.draftWeightKg = w;
          ctx.session.step = "awaiting_name";
          await ctx.reply(t(lang, "askName"));
          return;
        }
        case "awaiting_name": {
          if (text.length < 2) {
            await ctx.reply(t(lang, "askName"));
            return;
          }
          ctx.session.draftName = text.slice(0, 200);
          ctx.session.step = "awaiting_phone";
          await ctx.reply(t(lang, "askPhone"));
          return;
        }
        case "awaiting_phone": {
          const phone = text.replace(/[\s-]/g, "").slice(0, 30);
          if (phone.length < 6) {
            await ctx.reply(t(lang, "askPhone"));
            return;
          }
          ctx.session.draftPhone = phone;
          ctx.session.step = "awaiting_wilaya";
          await ctx.reply(t(lang, "askWilaya"));
          return;
        }
        case "awaiting_wilaya": {
          if (text.length < 2) {
            await ctx.reply(t(lang, "askWilaya"));
            return;
          }
          ctx.session.draftWilaya = text.slice(0, 100);
          ctx.session.step = "awaiting_address";
          await ctx.reply(t(lang, "askAddress"));
          return;
        }
        case "awaiting_address": {
          if (text.length < 5) {
            await ctx.reply(t(lang, "askAddress"));
            return;
          }
          const pending = ctx.session.pending;
          if (!pending) {
            ctx.session.step = "idle";
            await ctx.reply(t(lang, "sessionExpired"));
            return;
          }
          const telegramUserId = ctx.from?.id;
          if (!telegramUserId) {
            await ctx.reply("❌ تعذر تحديد هويتك. أرسل /start وحاول مجدداً.");
            return;
          }
          let cny: number;
          try {
            cny = (await getCnyPerUsd()).rate;
          } catch (fxErr) {
            console.error("FX unavailable at order time:", fxErr);
            ctx.session.step = "idle";
            await ctx.reply(
              "❌ تعذر حساب السعر حالياً (سعر الصرف غير متوفر). حاول مجدداً بعد قليل.",
            );
            return;
          }
          const usdRate = getUsdRate();
          const freightPerKg = getFreightPerKg();
          const quote = quotePrice({
            priceRmb: pending.priceRmb,
            quantity: ctx.session.draftQuantity,
            weightKg: ctx.session.draftWeightKg,
            cnyPerUsd: cny,
            usdRateDzd: usdRate,
            freightPerKgDzd: freightPerKg,
          });
          const order = createOrder({
            telegramUserId,
            fullName: ctx.session.draftName,
            phone: ctx.session.draftPhone,
            wilaya: ctx.session.draftWilaya,
            address: text.slice(0, 500),
            productUrl: pending.url,
            titleRaw: pending.title,
            priceRmb: pending.priceRmb,
            // Effective RMB→DZD rate actually charged (USD leg stays hidden).
            fxRateRmbDzd: usdRate / cny,
            quantity: quote.quantity,
            weightKg: quote.weightKg,
            freightDzd: quote.freightDzd,
            cnyPerUsd: cny,
            usdRateDzd: usdRate,
            totalAmountDzd: quote.totalAmountDzd,
            depositAmountDzd: quote.depositAmountDzd,
            remainingBalanceDzd: quote.remainingBalanceDzd,
            status: "AWAITING_DEPOSIT",
          });

          ctx.session.step = "idle";
          ctx.session.pending = null;
          ctx.session.draftQuantity = 1;
          ctx.session.draftWeightKg = 0;
          ctx.session.draftName = "";
          ctx.session.draftPhone = "";
          ctx.session.draftWilaya = "";

          const shippingLine =
            quote.weightKg > 0
              ? `🚚 الشحن التقديري (${quote.weightKg} kg): ${formatDzd(quote.freightDzd)}`
              : `🚚 الشحن: سيؤكده المشرف (الوزن غير معروف)`;

          await ctx.reply(
            [
              `${t(lang, "orderReceived")}`,
              ``,
              `🧾 طلب #${order.id} ×${quote.quantity}`,
              `📦 ${order.titleRaw.slice(0, 120)}`,
              `💴 سعر القطعة: ${pending.priceRmb} RMB ≈ ${formatDzd(quote.unitPriceDzd)}`,
              `📦 مجموع المنتج (${quote.quantity}): ${formatDzd(quote.productTotalDzd)}`,
              shippingLine,
              `💰 المجموع الإجمالي: ${formatDzd(order.totalAmountDzd)}`,
              quote.requiresFullPaymentUpfront
                ? `💳 الدفع المسبق الكامل: ${formatDzd(order.depositAmountDzd)}`
                : `💳 العربون: ${formatDzd(order.depositAmountDzd)} • الباقي: ${formatDzd(order.remainingBalanceDzd)}`,
              `🏷️ Shipping Mark: ${order.shippingMark}`,
              `📌 الحالة: ${order.status}`,
              ``,
              t(lang, "paymentNote"),
            ].join("\n"),
          );

          // Notify admin (fire-and-forget, never breaks customer flow)
          const adminId = process.env.ADMIN_TELEGRAM_ID;
          if (adminId) {
            try {
              await ctx.api.sendMessage(
                Number(adminId),
                `🆕 New order #${order.id}\n${order.titleRaw.slice(0, 100)}\n${formatDzd(order.totalAmountDzd)} • ${order.shippingMark}\nUse /order ${order.id}`,
              );
            } catch (notifyErr) {
              console.error("admin notify failed:", notifyErr);
            }
          }
          return;
        }
        default:
          break;
      }

      // --- Idle: expect a 1688 link ---
      const productUrl = extract1688Url(text);
      if (!productUrl) {
        // Only hint when the message looks like a link attempt or is short;
        // otherwise stay quiet to avoid spamming group chatter.
        if (/1688|http|www\.|\.com/i.test(text)) {
          await ctx.reply(t(lang, "badLink"));
        } else {
          await ctx.reply(t(lang, "sendLinkHint"));
        }
        return;
      }

      await ctx.reply(t(lang, "searching"));
      let scraped;
      try {
        scraped = await scrape1688Product(productUrl);
      } catch (err) {
        if (err instanceof Product1688ScrapeError) {
          console.warn("scrape failed:", err.message, err.url);
        } else {
          console.error("unexpected scrape error:", err);
        }
        await ctx.reply(t(lang, "scrapeFailed"));
        return;
      }

      const freightPerKg = getFreightPerKg();
      let unitDzd: number;
      try {
        const cny = await getCnyPerUsd();
        unitDzd = Math.round(
          (scraped.priceRmb / cny.rate) * getUsdRate(),
        );
      } catch (fxErr) {
        console.warn("FX unavailable for preview:", fxErr);
        await ctx.reply(
          "❌ تعذر حساب السعر حالياً (سعر الصرف غير متوفر). حاول مجدداً بعد قليل.",
        );
        return;
      }

      const pending: PendingProduct = {
        url: scraped.url,
        title: scraped.title,
        priceRmb: scraped.priceRmb,
        imageUrl: scraped.imageUrl,
        moq: scraped.moq,
        unitDzd,
      };
      ctx.session.pending = pending;

      const kb = new InlineKeyboard()
        .text("✅ تأكيد الطلب", "product:confirm")
        .text("❌ إلغاء", "product:cancel");

      const caption = productCaption(pending, freightPerKg);
      try {
        if (pending.imageUrl) {
          await ctx.replyWithPhoto(pending.imageUrl, {
            caption: caption.slice(0, 1024),
            reply_markup: kb,
          });
        } else {
          await ctx.reply(caption, { reply_markup: kb });
        }
      } catch (sendErr) {
        // Image URL may be hotlink-protected; fall back to text
        console.warn("photo send failed, falling back to text:", sendErr);
        await ctx.reply(caption, { reply_markup: kb });
      }
    } catch (err) {
      console.error("message handler failed:", err);
      try {
        await ctx.reply("❌ حدث خطأ غير متوقع. حاول مجدداً أو أرسل /start.");
      } catch {
        // ignore secondary failure
      }
    }
  });
}
