import { Bot, InlineKeyboard } from "grammy";
import {
  createOrder,
  getFreightPerKg,
  getUsdRate,
  listOrdersByUser,
} from "../db.js";
import { getCnyPerUsd } from "../fx.js";
import { formatDzd, t } from "../i18n.js";
import { priceForSelection, tierPriceFor, type VariantOption } from "../scraper/parse1688.js";
import { translatePicks, translateVariant } from "../variantDict.js";
import {
  is1688Url,
  Product1688ScrapeError,
  scrape1688Product,
} from "../scraper/index.js";
import { quotePrice } from "../pricing.js";
import type { Lang, MyContext, PendingProduct } from "../session.js";

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
    p.variants.length > 0
      ? `🎨 خيارات متوفرة (اللون / المقاس) — ستختارها بعد التأكيد`
      : null,
    ``,
    `🔗 ${p.url}`,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

function askVariantText(lang: Lang, opt: VariantOption): string {
  if (opt.kind === "color") return t(lang, "askVariantColor");
  if (opt.kind === "size") return t(lang, "askVariantSize");
  return t(lang, "askVariantOther").replace("{NAME}", opt.name);
}

function variantKeyboard(
  opt: VariantOption,
  optIdx: number,
  lang: Lang,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  opt.values.forEach((v, vi) => {
    kb.text(translateVariant(v, lang).slice(0, 40), `v:${optIdx}:${vi}`);
    if (vi % 2 === 1) kb.row();
  });
  return kb;
}

function askQuantityText(ctx: MyContext): string {
  let q = t(ctx.session.lang, "askQuantity");
  const moq = ctx.session.pending?.moq ?? null;
  if (moq !== null && moq > 1) {
    q += `\n📦 أقل كمية للطلب (MOQ): ${moq}`;
  }
  return q;
}

function askWeightText(ctx: MyContext): string {
  return t(ctx.session.lang, "askWeight").replace(
    "{FREIGHT}",
    Math.round(getFreightPerKg()).toLocaleString("en-US"),
  );
}

/** Unit DZD line for the chosen quantity (tier-aware). Empty when FX is down. */
async function unitDzdLine(
  pending: PendingProduct,
  qty: number,
): Promise<string> {
  const unitRmb =
    tierPriceFor(pending.tiers, qty) ?? pending.resolvedPriceRmb;
  try {
    const cny = await getCnyPerUsd();
    const dzd = Math.round((unitRmb / cny.rate) * getUsdRate());
    return `💴 سعر القطعة للكمية ${qty} ≈ ${formatDzd(dzd)}`;
  } catch {
    return "";
  }
}

async function askCurrentVariant(ctx: MyContext): Promise<void> {
  const pending = ctx.session.pending;
  const opt = pending?.variants[ctx.session.draftVariantIdx];
  if (!pending || !opt) {
    ctx.session.step = "awaiting_weight";
    await ctx.reply(askWeightText(ctx));
    return;
  }
  let msg = askVariantText(ctx.session.lang, opt);
  const line = await unitDzdLine(pending, ctx.session.draftQuantity);
  if (line) msg += `\n${line}`;
  await ctx.reply(msg, {
    reply_markup: variantKeyboard(opt, ctx.session.draftVariantIdx, ctx.session.lang),
  });
}

/** Prefer exact matches, then substring matches. */
function matchVariantValue(opt: VariantOption, raw: string): string | null {
  const n = raw.trim().toLowerCase();
  if (!n) return null;
  const exact = opt.values.find((v) => v.toLowerCase() === n);
  if (exact) return exact;
  return (
    opt.values.find((v) => {
      const lv = v.toLowerCase();
      return lv.includes(n) || n.includes(lv);
    }) ?? null
  );
}

async function recordVariantPick(
  ctx: MyContext,
  rawValue: string,
): Promise<void> {
  const pending = ctx.session.pending;
  if (!pending) {
    ctx.session.step = "idle";
    await ctx.reply(t(ctx.session.lang, "sessionExpired"));
    return;
  }
  const opt = pending.variants[ctx.session.draftVariantIdx];
  if (!opt) {
    ctx.session.step = "awaiting_quantity";
    await ctx.reply(askQuantityText(ctx));
    return;
  }
  const match = matchVariantValue(opt, rawValue);
  if (!match) {
    await ctx.reply(t(ctx.session.lang, "variantInvalid"));
    await askCurrentVariant(ctx);
    return;
  }
  ctx.session.draftPicks.push({ name: opt.name, value: match });
  ctx.session.draftVariantIdx += 1;
  if (ctx.session.draftVariantIdx < pending.variants.length) {
    await askCurrentVariant(ctx);
    return;
  }
  // All options picked — variant unit price resolves at order time from the
  // quantity tier (ladder), falling back to the matched SKU price.
  ctx.session.step = "awaiting_weight";
  await ctx.reply(askWeightText(ctx));
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
      ctx.session.draftVariantIdx = 0;
      ctx.session.draftPicks = [];
      ctx.session.draftQuantity = 1;
      // Quantity first (drives the tier price), then variants, then weight.
      ctx.session.step = "awaiting_quantity";
      await ctx.reply(askQuantityText(ctx));
    } catch (err) {
      console.error("confirm failed:", err);
      await ctx.reply("❌ حدث خطأ. حاول مجدداً.");
    }
  });

  // Variant option buttons: v:<optionIdx>:<valueIdx>
  bot.callbackQuery(/^v:(\d+):(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      if (ctx.session.step !== "awaiting_variant" || !ctx.session.pending) {
        await ctx.reply(t(ctx.session.lang, "sessionExpired"));
        return;
      }
      const optIdx = Number(ctx.match[1]);
      const valIdx = Number(ctx.match[2]);
      if (optIdx !== ctx.session.draftVariantIdx) return; // stale button
      const opt = ctx.session.pending.variants[optIdx];
      const value = opt?.values[valIdx];
      if (!value) {
        await ctx.reply(t(ctx.session.lang, "variantInvalid"));
        return;
      }
      await recordVariantPick(ctx, value);
    } catch (err) {
      console.error("variant pick failed:", err);
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
        case "awaiting_variant": {
          await recordVariantPick(ctx, text);
          return;
        }
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
          const pendingNow = ctx.session.pending;
          if (pendingNow && pendingNow.variants.length > 0) {
            ctx.session.step = "awaiting_variant";
            await askCurrentVariant(ctx);
          } else {
            ctx.session.step = "awaiting_weight";
            await ctx.reply(askWeightText(ctx));
          }
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
          ctx.session.step = "awaiting_postal";
          await ctx.reply(t(lang, "askPostal"));
          return;
        }
        case "awaiting_postal": {
          const postal = text.replace(/[\s-]/g, "");
          if (!/^\d{5}$/.test(postal)) {
            await ctx.reply(t(lang, "askPostalInvalid"));
            return;
          }
          ctx.session.draftPostalCode = postal;
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
          const qty = ctx.session.draftQuantity;
          // Unit price: ladder tier for this qty and matched-SKU price vote;
          // take the higher (never undercharge), but discard any signal that
          // is absurd next to the scraped price (e.g. cent-vs-yuan mixups).
          const tier = tierPriceFor(pending.tiers, qty);
          const ref = tier ?? pending.priceRmb;
          let sku = priceForSelection(pending.skus, ctx.session.draftPicks);
          if (sku !== null && (sku < ref * 0.1 || sku > ref * 10)) {
            console.warn(
              `Discarding implausible SKU price ${sku} vs ref ${ref}`,
            );
            sku = null;
          }
          const unitRmb = Math.max(tier ?? 0, sku ?? 0, pending.priceRmb);
          const quote = quotePrice({
            priceRmb: unitRmb,
            quantity: qty,
            weightKg: ctx.session.draftWeightKg,
            cnyPerUsd: cny,
            usdRateDzd: usdRate,
            freightPerKgDzd: freightPerKg,
          });
          const variantSummary = ctx.session.draftPicks
            .map((p) => p.value)
            .join(" / ")
            .slice(0, 200);
          const order = createOrder({
            telegramUserId,
            fullName: ctx.session.draftName,
            phone: ctx.session.draftPhone,
            wilaya: ctx.session.draftWilaya,
            postalCode: ctx.session.draftPostalCode,
            address: text.slice(0, 500),
            productUrl: pending.url,
            titleRaw: pending.title,
            priceRmb: unitRmb,
            imageUrl: pending.imageUrl,
            variantSummary,
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
          const picksForMsg = ctx.session.draftPicks;
          ctx.session.draftVariantIdx = 0;
          ctx.session.draftPicks = [];
          ctx.session.draftQuantity = 1;
          ctx.session.draftWeightKg = 0;
          ctx.session.draftName = "";
          ctx.session.draftPhone = "";
          ctx.session.draftWilaya = "";
          ctx.session.draftPostalCode = "";

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
              order.variantSummary
                ? `🎨 النوع: ${translatePicks(picksForMsg, lang) || order.variantSummary}`
                : null,
              `💴 سعر القطعة: ${unitRmb} RMB ≈ ${formatDzd(quote.unitPriceDzd)}`,
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
      // Preview unit for qty=1: ladder tier wins over the scraped lowest.
      const previewUnitRmb =
        tierPriceFor(scraped.tiers, 1) ?? scraped.priceRmb;
      let unitDzd: number;
      try {
        const cny = await getCnyPerUsd();
        unitDzd = Math.round(
          (previewUnitRmb / cny.rate) * getUsdRate(),
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
        variants: scraped.variants,
        skus: scraped.skus,
        tiers: scraped.tiers,
        resolvedPriceRmb: previewUnitRmb,
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
