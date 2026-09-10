/**
 * Alibaba.com product parser (prices already in USD — no CNY leg).
 *
 * Real product-detail structure:
 *   - og:title for the title (suffix " - Buy ... on Alibaba.com" stripped)
 *   - SKU ladder objects: {"dollarPrice":0.82,...,"min":200,"max":1999,
 *     "price":0.82,"promotionPrice":0.74} → quantity tiers
 *   - `mediaItems:[{...,"imageUrl":{"big":"https://sc04.alicdn.com/..."}}]`
 *   - MOQ: title="10pcs/model/color" after the MOQ label, or "Min. order: N"
 *
 * Variants (configurations) are intentionally NOT parsed in v1 — products
 * simply skip the allocation step, same graceful path as option-less pages.
 */

export interface AlibabaTier {
  minQty: number;
  price: number;
}

export interface ParsedAlibabaProduct {
  title: string;
  /** Unit USD for qty=1 (lowest rung). */
  priceUsd: number;
  imageUrl: string;
  moq: number | null;
  tiers: AlibabaTier[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanTitle(raw: string): string {
  return decodeEntities(raw)
    .replace(/\s*-\s*Buy\s+.+\s+on\s+Alibaba\.com\s*$/i, "")
    .replace(/\s*\|\s*Alibaba\.com\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function toNumber(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n < 100000000 ? n : null;
}

/** Quantity-break ladder from flat SKU objects. Never throws. */
export function extractAlibabaTiers(html: string): AlibabaTier[] {
  const tiers: AlibabaTier[] = [];
  // Flat objects only (no nested braces) — matches SKU rung entries.
  for (const m of html.matchAll(/\{[^{}]{0,600}?\}/g)) {
    const obj = m[0];
    if (!/"min"\s*:/.test(obj)) continue;
    const minM = obj.match(/"min"\s*:\s*"?([\d,]+)"?/);
    const priceM =
      obj.match(/"promotionDollarPrice"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/) ??
      obj.match(/"promotionPrice"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/) ??
      obj.match(/"(?:dollarPrice|price)"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/);
    if (!minM || !priceM) continue;
    const minQty = Math.floor(Number(minM[1].replace(/,/g, "")));
    const price = toNumber(priceM[1]);
    if (Number.isFinite(minQty) && minQty >= 1 && price !== null) {
      tiers.push({ minQty, price });
    }
  }
  tiers.sort((a, b) => a.minQty - b.minQty);
  const deduped: AlibabaTier[] = [];
  for (const t of tiers) {
    const last = deduped[deduped.length - 1];
    if (last && last.minQty === t.minQty) {
      if (t.price < last.price) last.price = t.price;
    } else {
      deduped.push({ ...t });
    }
  }
  return deduped;
}

export function tierPriceForQty(
  tiers: AlibabaTier[],
  qty: number,
): number | null {
  if (tiers.length === 0) return null;
  let price = tiers[0].price;
  for (const t of tiers) {
    if (qty >= t.minQty) price = t.price;
  }
  return price;
}

function extractImage(html: string): string {
  const big = html.match(
    /"big"\s*:\s*"(https?:\/\/[^"'\s\\]+?\.(?:jpe?g|png|webp))[^"'\s\\]*"/i,
  );
  if (big?.[1]) return big[1];
  const og = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og?.[1] && /alicdn\.com/i.test(og[1])) return og[1].trim();
  return "";
}

function extractMoq(html: string): number | null {
  // title="10pcs/model/color" right after the MOQ label
  const titled = html.match(
    /MOQ[\s\S]{0,600}?title="([\d,]+)\s*(?:pcs|pieces|sets|units)?/i,
  );
  if (titled) {
    const n = Number(titled[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const minOrder = html.match(/Min\.?\s*order[:\s]*([\d,]+)/i);
  if (minOrder) {
    const n = Number(minOrder[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Visible $ prices, excluding promo/legal junk contexts. */
function extractVisibleUsd(html: string): number[] {
  const found: number[] = [];
  for (const m of html.matchAll(/\$\s?[\d,]+(?:\.\d+)?/g)) {
    const idx = m.index ?? 0;
    const context = html.slice(Math.max(0, idx - 120), idx + 60);
    if (
      /compensation|prize|coupon|save up to|off shipping|exceeds|Up to US|US \$ ?\d/i.test(
        context,
      )
    ) {
      continue;
    }
    const n = toNumber(m[0].replace(/\$/g, ""));
    if (n !== null) found.push(n);
  }
  return found;
}

export function parseAlibabaProductHtml(
  html: string,
  url: string,
): ParsedAlibabaProduct {
  if (!html || html.length < 500) {
    throw new Error(
      `Empty or truncated HTML returned for ${url} (length ${html?.length ?? 0}).`,
    );
  }
  const ogTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  const titleTag = html.match(/<title[^>]*>([\s\S]{1,500}?)<\/title>/i);
  const rawTitle = ogTitle?.[1] ?? titleTag?.[1] ?? "";
  const title = cleanTitle(rawTitle.replace(/<[^>]+>/g, " "));
  if (!title) {
    throw new Error(
      "No product title found in page HTML (page may be a captcha/login wall).",
    );
  }

  const tiers = extractAlibabaTiers(html);
  const tier1 = tierPriceForQty(tiers, 1);
  const visible = extractVisibleUsd(html);
  const priceUsd = tier1 ?? (visible.length > 0 ? Math.min(...visible) : null);
  if (priceUsd === null) {
    throw new Error(
      "No USD price found in page HTML (page may require login or be a captcha wall).",
    );
  }

  return { title, priceUsd, imageUrl: extractImage(html), moq: extractMoq(html), tiers };
}
