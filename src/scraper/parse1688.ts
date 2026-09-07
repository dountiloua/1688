/**
 * Shared 1688 product-HTML parser.
 *
 * Both scraper providers (Oxylabs API and headless Playwright) feed raw HTML
 * through here, so price/title/image/MOQ extraction stays in one place.
 */

export interface Parsed1688Product {
  title: string;
  priceRmb: number;
  imageUrl: string;
  moq: number | null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&yen;|&#165;/gi, "¥")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " "))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTitle(html: string): string | null {
  // 1. Open-Graph title (most reliable)
  const og =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    );
  if (og?.[1]) return cleanTitle(og[1]);

  // 2. <title> tag
  const titleTag = html.match(/<title[^>]*>([\s\S]{1,500}?)<\/title>/i);
  if (titleTag?.[1]) return cleanTitle(stripTags(titleTag[1]));

  // 3. Embedded JSON title fields used by 1688 detail pages
  const jsonTitle = html.match(/"(?:title|subject|offerTitle)"\s*:\s*"(.{2,200}?)"/);
  if (jsonTitle?.[1]) return cleanTitle(decodeHtmlEntities(jsonTitle[1]));

  return null;
}

function cleanTitle(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/[-_|\s]*(阿里巴巴|1688|阿里巴巴批发网).*$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function parseFirstNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  // Sanity bounds: a single-unit 1688 price in RMB
  return Number.isFinite(n) && n > 0 && n < 100000000 ? n : null;
}

/**
 * Collect every plausible RMB price on the page, return the lowest
 * (1688 shows price ladders / ranges — spec says take the lowest tier).
 */
export function extractPricesRmb(html: string): number[] {
  const found: number[] = [];

  // ¥ / ￥ / &yen; prefixed amounts, incl. ranges ("¥12.5-18.9" -> 12.5 via parseFirstNumber)
  const symbolRe = /(?:¥|￥|&yen;|&#165;)\s?[\d,]+(?:\.\d+)?/gi;
  for (const m of html.matchAll(symbolRe)) {
    const n = parseFirstNumber(m[0]);
    if (n !== null) found.push(n);
  }

  // JSON price fields embedded by 1688 ("price":12.5, "showPrice":"12.50")
  const jsonRe =
    /"(?:price|showPrice|minPrice|discountPrice|offerPrice)"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/g;
  for (const m of html.matchAll(jsonRe)) {
    const n = parseFirstNumber(m[1]);
    if (n !== null) found.push(n);
  }

  return found;
}

export function extractImageUrl(html: string): string {
  // 1. Open-Graph image
  const og =
    html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    );
  if (og?.[1] && isHttpUrl(og[1])) return normalizeUrl(og[1]);

  // 2. Alibaba CDN image URLs embedded in JSON ("picUrl":"//cbu01.alicdn.com/...")
  const cdn = html.match(
    /"((?:https?:)?\/\/(?:cbu0\d|img)\.alicdn\.com[^"'\s\\]+?\.(?:jpe?g|png|webp))"/i,
  );
  if (cdn?.[1]) return normalizeUrl(cdn[1].replace(/\\/g, ""));

  // 3. Any alicdn <img> as last resort
  const img = html.match(
    /<img[^>]+src=["']((?:https?:)?\/\/[^"']*alicdn\.com[^"']*)["']/i,
  );
  if (img?.[1]) return normalizeUrl(img[1]);

  return "";
}

function isHttpUrl(value: string): boolean {
  return /^(https?:)?\/\//i.test(value.trim());
}

function normalizeUrl(value: string): string {
  let u = value.trim();
  if (u.startsWith("//")) u = "https:" + u;
  return /^https?:\/\//i.test(u) ? u : "";
}

export function extractMoq(html: string): number | null {
  const text = stripTags(html);
  const m = text.match(
    /(?:起批量|最小起订|起订量|MOQ)[^\d]{0,10}(\d[\d,]*)/,
  );
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse raw 1688 HTML into product data. Throws on missing title/price. */
export function parse1688ProductHtml(
  html: string,
  url: string,
): Parsed1688Product {
  if (!html || html.length < 500) {
    throw new Error(
      `Empty or truncated HTML returned for ${url} (length ${html?.length ?? 0}).`,
    );
  }

  const title = extractTitle(html);
  if (!title) {
    throw new Error(
      "No product title found in page HTML (page may be a captcha/login wall).",
    );
  }

  const prices = extractPricesRmb(html);
  if (prices.length === 0) {
    throw new Error(
      "No RMB price found in page HTML (page may require login or be a captcha wall).",
    );
  }
  const priceRmb = Math.min(...prices);

  return {
    title,
    priceRmb,
    imageUrl: extractImageUrl(html),
    moq: extractMoq(html),
  };
}
