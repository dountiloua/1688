import { Bot, InlineKeyboard } from "grammy";
import {
  createOrder,
  getBenefit,
  getFreightPerKg,
  getUsdRate,
  listOrdersByUser,
} from "../db.js";
import { getCnyPerUsd } from "../fx.js";
import { formatDzd, t } from "../i18n.js";
import { notifyAdmin } from "../notify.js";
import { tierPriceFor, type SkuEntry, type VariantOption } from "../scraper/parse1688.js";
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

function productCaption(p: PendingProduct): string {
  // Customer sees: RMB price → DZD price. Shipping is decided by the admin
  // later and never hinted up front; exchange internals stay hidden too.
  const lines = [
    `🧾 ${p.title}`,
    ``,
    `💴 السعر: ${p.priceRmb} RMB`,
    `💰 السعر بالدينار (للقطعة): ${formatDzd(p.unitDzd)}`,
    p.moq !== null ? `📦 أقل كمية للطلب (MOQ): ${p.moq}` : null,
    p.variants.length > 0
      ? `🎨 خيارات متوفرة (اللون / المقاس) — ستختارها بعد التأكيد`
      : null,
    ``,
    `🔗 ${p.url}`,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

function kindWord(lang: Lang, opt: VariantOption): string {
  if (opt.kind === "color")
    return lang === "ar" ? "🎨 اللون" : lang === "fr" ? "🎨 Couleur" : "🎨 Color";
  if (opt.kind === "size")
    return lang === "ar" ? "📏 المقاس" : lang === "fr" ? "📏 Taille" : "📏 Size";
  return `⚙️ ${opt.name}`;
}

function allocExample(opt: VariantOption, lang: Lang): string {
  const sep = lang === "ar" ? "، " : ", ";
  const parts: string[] = [];
  if (opt.values[0]) parts.push(`${translateVariant(opt.values[0], lang)} 1`);
  if (opt.values[1]) parts.push(`${translateVariant(opt.values[1], lang)} 2`);
  return parts.join(sep);
}

function allocSum(alloc: Record<string, number>): number {
  return Object.values(alloc).reduce(
    (a, b) => a + (Number.isFinite(b) ? b : 0),
    0,
  );
}

function emptyAlloc(opt: VariantOption): Record<string, number> {
  return Object.fromEntries(opt.values.map((v) => [v, 0]));
}

async function allocText(ctx: MyContext, opt: VariantOption): Promise<string> {
  const lang = ctx.session.lang;
  const n = ctx.session.draftQuantity;
  let msg = t(lang, "askVariantAlloc")
    .replace("{N}", String(n))
    .replace("{OPT}", `${kindWord(lang, opt)} (${opt.name})`)
    .replace("{EX}", allocExample(opt, lang))
    .replace("{SUM}", String(allocSum(ctx.session.draftAlloc)));
  const line = await unitDzdLine(ctx.session.pending, n);
  if (line) msg += `\n${line}`;
  return msg;
}

function allocKeyboard(ctx: MyContext, optIdx: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const pending = ctx.session.pending;
  const opt = pending?.variants[optIdx];
  if (!opt) return kb;
  const lang = ctx.session.lang;
  const n = ctx.session.draftQuantity;
  opt.values.forEach((v, vi) => {
    const count = ctx.session.draftAlloc[v] ?? 0;
    kb.text("−", `vq:${optIdx}:${vi}:-`)
      .text(
        `${translateVariant(v, lang).slice(0, 26)} ×${count}`,
        `vq:${optIdx}:${vi}:+`,
      )
      .text("+", `vq:${optIdx}:${vi}:+`);
    kb.row();
  });
  kb.text(
    `${t(lang, "variantDone")} (${allocSum(ctx.session.draftAlloc)}/${n})`,
    `vqdone:${optIdx}`,
  );
  return kb;
}

/** Send (or re-target) the allocation question for the current option. */
async function sendAllocMessage(ctx: MyContext): Promise<void> {
  const pending = ctx.session.pending;
  const opt = pending?.variants[ctx.session.draftVariantIdx];
  if (!pending || !opt) {
    ctx.session.step = "awaiting_name";
    await ctx.reply(t(ctx.session.lang, "askName"));
    return;
  }
  ctx.session.draftAlloc = emptyAlloc(opt);
  const sent = await ctx.reply(await allocText(ctx, opt), {
    reply_markup: allocKeyboard(ctx, ctx.session.draftVariantIdx),
  });
  ctx.session.draftAllocMsgId = sent.message_id;
}

/** Re-render the live allocation keyboard after a tap / typed input. */
async function refreshAllocMessage(
  ctx: MyContext,
  messageId?: number,
): Promise<void> {
  const pending = ctx.session.pending;
  const opt = pending?.variants[ctx.session.draftVariantIdx];
  if (!pending || !opt) return;
  const text = await allocText(ctx, opt);
  const markup = allocKeyboard(ctx, ctx.session.draftVariantIdx);
  try {
    if (messageId !== undefined && ctx.chat) {
      await ctx.api.editMessageText(ctx.chat.id, messageId, text, {
        reply_markup: markup,
      });
    } else {
      await ctx.editMessageText(text, { reply_markup: markup });
    }
  } catch {
    // Message not modified or too old — harmless, the numbers are in sync.
  }
}

function askQuantityText(ctx: MyContext): string {
  let q = t(ctx.session.lang, "askQuantity");
  const moq = ctx.session.pending?.moq ?? null;
  if (moq !== null && moq > 1) {
    q += `\n📦 أقل كمية للطلب (MOQ): ${moq}`;
  }
  return q;
}

/** Unit DZD line for the chosen quantity (tier-aware). Empty when FX is down. */
async function unitDzdLine(
  pending: PendingProduct | null,
  qty: number,
): Promise<string> {
  if (!pending) return "";
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

/** Highest SKU price touching ANY picked pair (size premiums etc.). */
function maxSkuPrice(
  skus: SkuEntry[],
  picks: { name: string; value: string }[],
): number | null {
  if (picks.length === 0 || skus.length === 0) return null;
  const norm = (s: string): string => s.trim().toLowerCase();
  const hit = skus.filter((s) =>
    picks.some((p) =>
      s.specs.some(
        (spec) => norm(spec.name) === norm(p.name) && norm(spec.value) === norm(p.value),
      ),
    ),
  );
  if (hit.length === 0) return null;
  return Math.max(...hit.map((s) => s.price));
}

/**
 * Parse typed allocation like "white 2, green 1" / "أبيض 1، أخضر 2" /
 * "40 2 41 1" into value→qty. Returns null when anything doesn't match.
 */
export function parseAllocation(
  text: string,
  opt: VariantOption,
): Record<string, number> | null {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const norm = text
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[،;；]/g, ",");
  // Alias per value: original + ar/fr/en dictionary translations.
  // Leftmost-longest match wins, so "Black1 2" never parses as Black.
  const aliases: { value: string; pattern: string }[] = [];
  for (const v of opt.values) {
    const names = new Set([
      v,
      translateVariant(v, "ar"),
      translateVariant(v, "fr"),
      translateVariant(v, "en"),
    ]);
    for (const a of names) {
      const trimmed = a.trim();
      if (trimmed) aliases.push({ value: v, pattern: trimmed });
    }
  }
  aliases.sort((a, b) => b.pattern.length - a.pattern.length);
  const alloc = emptyAlloc(opt);
  let pos = 0;
  let matchedAny = false;
  while (pos < norm.length) {
    if (/[\s,]/.test(norm[pos])) {
      pos++;
      continue;
    }
    let consumed = false;
    for (const a of aliases) {
      if (
        norm.slice(pos, pos + a.pattern.length).toLowerCase() !==
        a.pattern.toLowerCase()
      ) {
        continue;
      }
      const tail = norm.slice(pos + a.pattern.length);
      const tailMatch = tail.match(/^\s*[x×]?\s*(\d+)/);
      if (!tailMatch) continue;
      const qty = Number(tailMatch[1]);
      if (qty <= 0 || qty > 1000000) return null;
      alloc[a.value] = (alloc[a.value] ?? 0) + qty;
      pos += a.pattern.length + tailMatch[0].length;
      matchedAny = true;
      consumed = true;
      break;
    }
    if (!consumed) return null;
  }
  return matchedAny ? alloc : null;
}

/** Lock the current option's allocation into picks, advance or finish. */
async function finishAllocOption(ctx: MyContext): Promise<void> {
  const pending = ctx.session.pending;
  if (!pending) {
    ctx.session.step = "idle";
    await ctx.reply(t(ctx.session.lang, "sessionExpired"));
    return;
  }
  const opt = pending.variants[ctx.session.draftVariantIdx];
  if (opt) {
    for (const v of opt.values) {
      const q = ctx.session.draftAlloc[v] ?? 0;
      if (q > 0) {
        ctx.session.draftPicks.push({ name: opt.name, value: v, qty: q });
      }
    }
  }
  ctx.session.draftVariantIdx += 1;
  await sendAllocMessage(ctx);
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
      const lines = orders.map((o) =>
        o.status === "PENDING_ACCEPTANCE"
          ? `#${o.id} • قيد مراجعة المشرف ⏳\n${o.titleRaw.slice(0, 60)} ×${o.quantity || 1}\n${o.shippingMark}`
          : `#${o.id} • ${o.status}\n${o.titleRaw.slice(0, 60)} ×${o.quantity || 1}\n${formatDzd(o.totalAmountDzd)} • ${o.shippingMark}`,
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
      ctx.session.draftAlloc = {};
      ctx.session.draftAllocMsgId = null;
      ctx.session.draftQuantity = 1;
      // Quantity first (drives the tier price + allocation total), then variants.
      ctx.session.step = "awaiting_quantity";
      await ctx.reply(askQuantityText(ctx));
    } catch (err) {
      console.error("confirm failed:", err);
      await ctx.reply("❌ حدث خطأ. حاول مجدداً.");
    }
  });

  // Variant allocation steppers: vq:<optionIdx>:<valueIdx>:<+|->
  bot.callbackQuery(/^vq:(\d+):(\d+):([+-])$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      if (ctx.session.step !== "awaiting_variant" || !ctx.session.pending) {
        await ctx.reply(t(ctx.session.lang, "sessionExpired"));
        return;
      }
      const optIdx = Number(ctx.match[1]);
      const valIdx = Number(ctx.match[2]);
      const delta = ctx.match[3] === "+" ? 1 : -1;
      if (optIdx !== ctx.session.draftVariantIdx) return; // stale button
      const opt = ctx.session.pending.variants[optIdx];
      const value = opt?.values[valIdx];
      if (!value || !opt) {
        await ctx.reply(t(ctx.session.lang, "variantInvalid"));
        return;
      }
      const n = ctx.session.draftQuantity;
      const cur = ctx.session.draftAlloc[value] ?? 0;
      ctx.session.draftAlloc[value] = Math.min(
        n,
        Math.max(0, cur + delta),
      );
      await refreshAllocMessage(ctx);
    } catch (err) {
      console.error("variant stepper failed:", err);
      await ctx.reply("❌ حدث خطأ. حاول مجدداً.");
    }
  });

  // Allocation done: vqdone:<optionIdx>
  bot.callbackQuery(/^vqdone:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      if (ctx.session.step !== "awaiting_variant" || !ctx.session.pending) {
        await ctx.reply(t(ctx.session.lang, "sessionExpired"));
        return;
      }
      if (Number(ctx.match[1]) !== ctx.session.draftVariantIdx) return;
      const sum = allocSum(ctx.session.draftAlloc);
      const n = ctx.session.draftQuantity;
      if (sum !== n) {
        await ctx.reply(
          t(ctx.session.lang, "allocMismatch")
            .replace("{SUM}", String(sum))
            .replace("{N}", String(n)),
        );
        return;
      }
      await finishAllocOption(ctx);
    } catch (err) {
      console.error("variant done failed:", err);
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
          const pending = ctx.session.pending;
          const opt = pending?.variants[ctx.session.draftVariantIdx];
          if (!pending || !opt) {
            await sendAllocMessage(ctx);
            return;
          }
          const parsed = parseAllocation(text, opt);
          if (!parsed) {
            await ctx.reply(t(lang, "variantInvalid"));
            return;
          }
          ctx.session.draftAlloc = parsed;
          // Re-render the live keyboard so counts match the typed input.
          const msgId = ctx.session.draftAllocMsgId;
          if (msgId != null && ctx.chat) {
            try {
              await ctx.api.editMessageText(ctx.chat.id, msgId, await allocText(ctx, opt), {
                reply_markup: allocKeyboard(ctx, ctx.session.draftVariantIdx),
              });
            } catch {
              const sent = await ctx.reply(await allocText(ctx, opt), {
                reply_markup: allocKeyboard(ctx, ctx.session.draftVariantIdx),
              });
              ctx.session.draftAllocMsgId = sent.message_id;
            }
          } else {
            const sent = await ctx.reply(await allocText(ctx, opt), {
              reply_markup: allocKeyboard(ctx, ctx.session.draftVariantIdx),
            });
            ctx.session.draftAllocMsgId = sent.message_id;
          }
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
            await sendAllocMessage(ctx);
          } else {
            ctx.session.step = "awaiting_name";
            await ctx.reply(t(lang, "askName"));
          }
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
          let sku = maxSkuPrice(pending.skus, ctx.session.draftPicks);
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
            weightKg: 0,
            cnyPerUsd: cny,
            usdRateDzd: usdRate,
            freightPerKgDzd: freightPerKg,
            benefitDzd: getBenefit(),
          });
          const variantSummary = ctx.session.draftPicks
            .filter((p) => p.qty > 0)
            .map((p) => `${p.value}×${p.qty}`)
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
            approxTotalDzd: quote.totalAmountDzd,
            totalAmountDzd: quote.totalAmountDzd,
            depositAmountDzd: quote.depositAmountDzd,
            remainingBalanceDzd: quote.remainingBalanceDzd,
            status: "PENDING_ACCEPTANCE",
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
              `⏳ السعر النهائي وطريقة الدفع يحددهما المشرف لاحقاً`,
              `🏷️ Shipping Mark: ${order.shippingMark}`,
              `📌 الحالة: قيد مراجعة المشرف ⏳`,
              ``,
              t(lang, "approxNote"),
              t(lang, "paymentNote"),
            ].join("\n"),
          );

          // Notify admin on the PRIVATE notifications bot (fire-and-forget,
          // never breaks customer flow; falls back to this bot if unset).
          const adminId = process.env.ADMIN_TELEGRAM_ID;
          if (adminId) {
            const alert =
              `🆕 New order #${order.id} (needs acceptance)\n${order.titleRaw.slice(0, 100)}\nApprox ${formatDzd(order.totalAmountDzd)} • ${order.shippingMark}\nAccept: panel or /accept ${order.id} <final_price>`;
            try {
              const handled = await notifyAdmin(alert);
              if (!handled) {
                await ctx.api.sendMessage(Number(adminId), alert);
              }
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

      const caption = productCaption(pending);
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
