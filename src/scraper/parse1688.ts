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
  variants: VariantOption[];
  skus: SkuEntry[];
  tiers: PriceTier[];
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
 *
 * ¥-amounts sitting next to freight/shipping words (e.g. "运费¥4起" =
 * "shipping from ¥4") are NOT product prices and are skipped.
 */
export function extractPricesRmb(html: string): number[] {
  const found: number[] = [];

  // ¥ / ￥ / &yen; prefixed amounts, incl. ranges ("¥12.5-18.9" -> 12.5 via parseFirstNumber)
  const symbolRe = /(?:¥|￥|&yen;|&#165;)\s?[\d,]+(?:\.\d+)?/gi;
  for (const m of html.matchAll(symbolRe)) {
    const idx = m.index ?? 0;
    const context = html.slice(Math.max(0, idx - 100), idx + 60);
    if (
      /运费|邮费|快递费|运费险|邮资|freight|shipping|postage|物流|到付|delivery fee/i.test(
        context,
      )
    ) {
      continue;
    }
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

/**
 * The page's own displayed price (`priceDisplay`, `minPrice`, ...).
 * More authoritative than any ¥-scraping heuristic.
 */
export function extractDisplayPrice(html: string): number | null {
  const re =
    /"(?:priceDisplay|minPrice|offerMinPrice)"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/g;
  let best: number | null = null;
  for (const m of html.matchAll(re)) {
    const n = parseFirstNumber(m[1]);
    if (n !== null && (best === null || n < best)) best = n;
  }
  return best;
}

export function extractImageUrl(html: string): string {
  const candidates: string[] = [];

  // 1. Open-Graph image
  const og =
    html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    );
  if (og?.[1] && isHttpUrl(og[1])) candidates.push(og[1]);

  // 2. Gallery image URLs embedded in JSON
  for (const m of html.matchAll(
    /"(?:picUrl|originalImage|imageUrl|imgUrl|mainImage)"\s*:\s*"((?:https?:)?\/\/[^"'\s\\]+)"/gi,
  )) {
    if (isHttpUrl(m[1])) candidates.push(m[1].replace(/\\/g, ""));
  }

  // 3. Alibaba CDN <img> tags
  for (const m of html.matchAll(
    /<img[^>]+src=["']((?:https?:)?\/\/[^"']*alicdn\.com[^"']*)["']/gi,
  )) {
    candidates.push(m[1]);
  }

  // Product photos live on cbu hosts; img/imgextra hosts are mostly UI icons.
  const good = candidates
    .map(normalizeUrl)
    .filter((u) => u && !isJunkImageUrl(u));
  return (
    good.find((u) => u.includes("/cbu") || u.includes("ibank")) ?? good[0] ?? ""
  );
}

/** Reject UI icons, sprites, thumbnails and placeholder graphics. */
function isJunkImageUrl(url: string): boolean {
  const l = url.toLowerCase();
  if (/\.svg(\?|$)/.test(l)) return true; // vector UI icons
  if (l.includes("-tps-")) return true; // tiny UI sprites (e.g. 15-14px)
  if (
    /captcha|lock|loading|placeholder|nofoto|no-image|blank|spacer|pixel|default-avatar|404|error/i.test(
      l,
    )
  ) {
    return true;
  }
  // Trailing dimension suffixes: -58-60.png, _50x50.jpg, etc.
  const dim =
    l.match(/[_-](\d{1,4})x(\d{1,4})\.(png|jpe?g|webp|gif)/) ??
    l.match(/-(\d{1,4})-(\d{1,4})\.(png|jpe?g|webp|gif)(?:\?|$)/);
  if (dim) {
    const w = Number(dim[1]);
    const h = Number(dim[2]);
    if (Math.max(w, h) < 250) return true;
  }
  return false;
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

  let variants: VariantOption[] = [];
  let skus: SkuEntry[] = [];
  let tiers: PriceTier[] = [];
  try {
    const v = extractVariants(html);
    variants = v.options;
    skus = v.skus;
    tiers = v.tiers;
  } catch {
    // Variants are optional — never fail a scrape because of them.
  }

  const prices = extractPricesRmb(html);
  const visibleMin = prices.length > 0 ? Math.min(...prices) : null;

  // Price priority: quantity-ladder rung for 1 piece > the page's own
  // displayed price > visible-¥ heuristic. The heuristic is blind — it once
  // picked "运费¥4起" (shipping-from-¥4) over the real ¥28 product price —
  // so it only ever wins when nothing structured exists.
  const tier1 = tierPriceFor(tiers, 1);
  const display = extractDisplayPrice(html);
  const priceRmb: number | null = tier1 ?? display ?? visibleMin;
  if (priceRmb === null) {
    throw new Error(
      "No RMB price found in page HTML (page may require login or be a captcha wall).",
    );
  }

  // The quantity ladder's first rung doubles as the effective MOQ.
  let moq = extractMoq(html);
  if (tiers.length > 0) {
    const ladderMoq = tiers[0].minQty;
    if (ladderMoq > (moq ?? 0)) moq = ladderMoq;
  }

  return {
    title,
    priceRmb,
    imageUrl: extractImageUrl(html),
    moq,
    variants,
    skus,
    tiers,
  };
}

/* ---------------- Variants (color / size / SKU prices) ---------------- */

export type VariantKind = "color" | "size" | "other";

export interface VariantOption {
  kind: VariantKind;
  /** Original option name as declared on the page (e.g. "颜色", "尺码"). */
  name: string;
  values: string[];
}

export interface SkuEntry {
  price: number;
  specs: { name: string; value: string }[];
}

/** Quantity-break ladder: unit price for orders of >= minQty pieces. */
export interface PriceTier {
  minQty: number;
  price: number;
}

export interface VariantData {
  options: VariantOption[];
  skus: SkuEntry[];
  tiers: PriceTier[];
}

const MAX_OPTIONS = 6;
const MAX_VALUES = 24;

function classifyVariant(name: string): VariantKind {
  if (/颜色|color|colour|花色/i.test(name)) return "color";
  if (/尺码|尺寸|size|码数|鞋码/i.test(name)) return "size";
  return "other";
}

function cleanVariantValue(value: string): string | null {
  const v = decodeHtmlEntities(value).replace(/\s+/g, " ").trim().slice(0, 40);
  if (!v || /请选择|select an option|_fake/i.test(v)) return null;
  return v;
}

/** Slice a balanced [...] or {...} substring starting at openIdx. */
function balancedSlice(src: string, openIdx: number): string | null {
  const open = src[openIdx];
  const close = open === "[" ? "]" : open === "{" ? "}" : null;
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

function readSpecName(o: Record<string, unknown>): string | null {
  for (const k of ["specName", "propName", "attrName", "name", "key", "title"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
  }
  return null;
}

function readSpecValue(o: Record<string, unknown>): string | null {
  for (const k of ["specValue", "propValue", "attrValue", "value", "val", "text"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      return cleanVariantValue(v);
    }
  }
  return null;
}

function readSkuPrice(o: Record<string, unknown>): number | null {
  // Order matters: real charge prices first, ambiguous counters last.
  // (`priceAmount` is unreliable — on some pages it's the ladder floor,
  // on others a meaningless flag.)
  for (const k of [
    "discountPrice",
    "price",
    "salePrice",
    "minPrice",
    "skuPrice",
    "priceText",
    "promotionPrice",
    "priceAmount",
  ]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100000000) {
      return v;
    }
    if (typeof v === "string") {
      const n = parseFirstNumber(v.replace(/¥|￥|RMB/gi, ""));
      if (n !== null) return n;
    }
  }
  return null;
}

const SPEC_ARRAY_KEYS = [
  "specList",
  "specs",
  "attributes",
  "spec",
  "skuAttr",
  "skuAttrs",
  "propList",
  "props",
];

function readSpecs(o: Record<string, unknown>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  // {specList: [{specName, specValue}]} style
  for (const k of SPEC_ARRAY_KEYS) {
    const arr = o[k];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const name = readSpecName(item as Record<string, unknown>);
        const value = readSpecValue(item as Record<string, unknown>);
        if (name && value) out.push({ name, value });
      }
    }
  }
  // {"颜色": "红色"} map style (only when the object has no price of its own context issues — caller decides)
  return out;
}

function collectSkus(node: unknown, out: SkuEntry[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectSkus(n, out);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const price = readSkuPrice(o);
    let specs = readSpecs(o);
    // Map-style specs: {"颜色": "红", "尺码": "XL"} alongside a price
    if (price !== null && specs.length === 0) {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && v.trim() && k.length <= 20) {
          const cleaned = cleanVariantValue(v);
          const key = k.trim().slice(0, 40);
          if (cleaned && /颜色|尺码|尺寸|size|color|尺码|码|款|色/i.test(key)) {
            specs.push({ name: key, value: cleaned });
          }
        }
      }
    }
    if (price !== null && specs.length > 0) {
      out.push({ price, specs });
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") collectSkus(v, out);
    }
  }
}

/**
 * Extract variant options + SKU prices + quantity ladder from 1688 HTML.
 * Real detail-page structure:
 *   - `skuProps: [{prop: "Color", value: [{name: "Blue1"}, ...]}]` (ordered!)
 *   - `skuInfoMap` / `skuMap`: `{specAttrs: "Blue1&gt;iPhone X", priceAmount: 2}`
 *     (segments are positional — segment i belongs to skuProps[i])
 *   - `currentPrices: [{beginAmount: 2, price: "3.50"}, ...]` quantity ladder.
 * Never throws — returns empty options when the page declares none.
 */
export function extractVariants(html: string): VariantData {
  const skus: SkuEntry[] = [];

  // 1a. Legacy generic walker (other 1688 templates)
  for (const marker of ['"skuList"', '"skuInfos"']) {
    let from = 0;
    while (true) {
      const mi = html.indexOf(marker, from);
      if (mi === -1) break;
      const colon = html.indexOf(":", mi + marker.length);
      if (colon === -1) break;
      let openIdx = colon + 1;
      while (openIdx < html.length && /\s/.test(html[openIdx])) openIdx++;
      if (html[openIdx] !== "[" && html[openIdx] !== "{") {
        from = mi + marker.length;
        continue;
      }
      const slice = balancedSlice(html, openIdx);
      from = mi + marker.length;
      if (!slice || slice.length > 2_000_000) continue;
      try {
        collectSkus(JSON.parse(slice) as unknown, skus);
        if (skus.length > 500) break;
      } catch {
        // not valid JSON — ignore, fall through to other sources
      }
    }
    if (skus.length > 500) break;
  }

  // 1b. Declared sale options, in display order.
  const declared = parseSkuProps(html);

  // 1c. SKU map entries with positional spec segments.
  for (const entry of parseSkuMapEntries(html)) {
    const specs = entry.segments.map((value, i) => ({
      name: declared[i]?.name ?? `规格${i + 1}`,
      value,
    }));
    if (specs.length > 0) skus.push({ price: entry.price, specs });
  }

  // 2. Regex fallback: specName/specValue pairs (no price link)
  const pairSpecs: { name: string; value: string }[] = [];
  const pairRe =
    /"specName"\s*:\s*"([^"]{1,40})"\s*,\s*"specValue"\s*:\s*"([^"]{1,60})"/g;
  const pairRe2 =
    /"specValue"\s*:\s*"([^"]{1,60})"\s*,\s*"specName"\s*:\s*"([^"]{1,40})"/g;
  for (const m of html.matchAll(pairRe)) {
    const value = cleanVariantValue(m[2]);
    if (m[1].trim() && value) pairSpecs.push({ name: m[1].trim(), value });
  }
  for (const m of html.matchAll(pairRe2)) {
    const value = cleanVariantValue(m[1]);
    if (m[2].trim() && value) pairSpecs.push({ name: m[2].trim(), value });
  }

  // 3. Group into options: declared first, extras fill gaps.
  const grouped = new Map<string, { order: number; values: string[] }>();
  let order = 0;
  const addOption = (name: string, values: string[]): void => {
    if (grouped.has(name)) return;
    const clean = values
      .map((v) => cleanVariantValue(v))
      .filter((v): v is string => v !== null)
      .slice(0, MAX_VALUES);
    if (clean.length > 0) grouped.set(name, { order: order++, values: clean });
  };
  const addSpec = (name: string, value: string): void => {
    let g = grouped.get(name);
    if (!g) {
      g = { order: order++, values: [] };
      grouped.set(name, g);
    }
    if (!g.values.includes(value) && g.values.length < MAX_VALUES) {
      g.values.push(value);
    }
  };
  for (const d of declared) addOption(d.name, d.values);
  for (const s of skus) {
    for (const spec of s.specs) addSpec(spec.name, spec.value);
  }
  for (const p of pairSpecs) addSpec(p.name, p.value);

  const options: VariantOption[] = [...grouped.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .slice(0, MAX_OPTIONS)
    .filter(([, g]) => g.values.length > 0)
    .map(([name, g]) => ({
      kind: classifyVariant(name),
      name,
      values: g.values,
    }));

  // Dedupe SKUs
  const seen = new Set<string>();
  const uniqSkus = skus.filter((s) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    options,
    skus: options.length > 0 ? uniqSkus : [],
    tiers: parseTiers(html),
  };
}

/** Parse `skuProps: [{prop, value: [{name}]}]` — first occurrence per prop wins. */
function parseSkuProps(html: string): { name: string; values: string[] }[] {
  const out: { name: string; values: string[] }[] = [];
  const seenNames = new Set<string>();
  let from = 0;
  while (true) {
    const mi = html.indexOf('"skuProps"', from);
    if (mi === -1) break;
    const colon = html.indexOf(":", mi + 10);
    if (colon === -1) break;
    let openIdx = colon + 1;
    while (openIdx < html.length && /\s/.test(html[openIdx])) openIdx++;
    from = mi + 10;
    if (html[openIdx] !== "[") continue;
    const slice = balancedSlice(html, openIdx);
    if (!slice || slice.length > 500_000) continue;
    try {
      const arr: unknown = JSON.parse(slice);
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const o = item as Record<string, unknown>;
        const rawName = o.prop ?? o.name ?? o.title;
        if (typeof rawName !== "string" || !rawName.trim()) continue;
        const name = rawName.trim().slice(0, 40);
        if (seenNames.has(name.toLowerCase())) continue;
        const rawValues = o.value ?? o.values ?? o.valueList;
        if (!Array.isArray(rawValues)) continue;
        const values: string[] = [];
        for (const v of rawValues) {
          if (typeof v === "string") {
            const c = cleanVariantValue(v);
            if (c) values.push(c);
          } else if (v && typeof v === "object" && !Array.isArray(v)) {
            const n = (v as Record<string, unknown>).name;
            if (typeof n === "string") {
              const c = cleanVariantValue(n);
              if (c) values.push(c);
            }
          }
          if (values.length >= MAX_VALUES) break;
        }
        if (values.length > 0) {
          seenNames.add(name.toLowerCase());
          out.push({ name, values });
        }
      }
      if (out.length > 0) break; // first valid block is enough
    } catch {
      // ignore and keep scanning
    }
  }
  return out.slice(0, MAX_OPTIONS);
}

/** Parse `skuInfoMap` / `skuMap` entries into positional spec segments. */
function parseSkuMapEntries(
  html: string,
): { segments: string[]; price: number }[] {
  const out: { segments: string[]; price: number }[] = [];
  for (const marker of [
    '"skuInfoMapOriginal"',
    '"skuInfoMap"',
    '"skuMap"',
  ]) {
    let from = 0;
    while (true) {
      const mi = html.indexOf(marker, from);
      if (mi === -1) break;
      const colon = html.indexOf(":", mi + marker.length);
      if (colon === -1) break;
      let openIdx = colon + 1;
      while (openIdx < html.length && /\s/.test(html[openIdx])) openIdx++;
      from = mi + marker.length;
      if (html[openIdx] !== "[" && html[openIdx] !== "{") continue;
      const slice = balancedSlice(html, openIdx);
      if (!slice || slice.length > 2_000_000) continue;
      try {
        const parsed: unknown = JSON.parse(slice);
        const items: unknown[] = Array.isArray(parsed)
          ? parsed
          : Object.values(parsed as Record<string, unknown>);
        for (const item of items) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const o = item as Record<string, unknown>;
          const rawAttrs = o.specAttrs ?? o.spec_attrs;
          const rawPrice = o.priceAmount ?? o.price;
          if (typeof rawAttrs !== "string") continue;
          const price =
            typeof rawPrice === "number"
              ? rawPrice
              : typeof rawPrice === "string"
                ? (parseFirstNumber(rawPrice) ?? NaN)
                : NaN;
          if (!Number.isFinite(price) || price <= 0 || price >= 100000000) continue;
          const segments = rawAttrs
            .split(/&gt;|>/)
            .map((s) => cleanVariantValue(s))
            .filter((s): s is string => s !== null);
          if (segments.length > 0) out.push({ segments, price });
        }
        if (out.length > 0) break;
      } catch {
        // ignore and keep scanning
      }
    }
    if (out.length > 0) break;
  }
  return out;
}

/** Parse quantity-break ladders (`currentPrices`, `skuRangePrices`, ...). */
function parseTiers(html: string): PriceTier[] {
  const tiers: PriceTier[] = [];
  for (const marker of [
    '"currentPrices"',
    '"skuRangePrices"',
    '"disPriceRanges"',
  ]) {
    let from = 0;
    while (true) {
      const mi = html.indexOf(marker, from);
      if (mi === -1) break;
      const colon = html.indexOf(":", mi + marker.length);
      if (colon === -1) break;
      let openIdx = colon + 1;
      while (openIdx < html.length && /\s/.test(html[openIdx])) openIdx++;
      from = mi + marker.length;
      if (html[openIdx] !== "[") continue;
      const slice = balancedSlice(html, openIdx);
      if (!slice || slice.length > 100_000) continue;
      try {
        const arr: unknown = JSON.parse(slice);
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const o = item as Record<string, unknown>;
          if ("$ref" in o) continue; // JSON-ref placeholder, not a real tier
          const minQty = Number(o.beginAmount ?? o.minNum ?? o.startAmount);
          const rawPrice = o.discountPrice ?? o.price;
          const price =
            typeof rawPrice === "number"
              ? rawPrice
              : typeof rawPrice === "string"
                ? (parseFirstNumber(rawPrice) ?? NaN)
                : NaN;
          if (
            Number.isFinite(minQty) &&
            minQty >= 1 &&
            Number.isFinite(price) &&
            price > 0 &&
            price < 100000000
          ) {
            tiers.push({ minQty: Math.floor(minQty), price });
          }
        }
      } catch {
        // ignore
      }
    }
  }
  tiers.sort((a, b) => a.minQty - b.minQty);
  // Dedupe equal rungs (keep lowest price)
  const deduped: PriceTier[] = [];
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

/** Unit RMB price for a quantity from the ladder (null when no ladder). */
export function tierPriceFor(tiers: PriceTier[], qty: number): number | null {
  if (tiers.length === 0) return null;
  let price = tiers[0].price;
  for (const t of tiers) {
    if (qty >= t.minQty) price = t.price;
  }
  return price;
}

/**
 * Resolve the unit RMB price for a customer's variant picks.
 * Returns the lowest SKU price matching ALL picks, or null when unknown.
 */
export function priceForSelection(
  skus: SkuEntry[],
  picks: { name: string; value: string }[],
): number | null {
  if (picks.length === 0 || skus.length === 0) return null;
  const norm = (s: string): string => s.trim().toLowerCase();
  const matching = skus.filter((s) =>
    picks.every((p) =>
      s.specs.some(
        (spec) => norm(spec.name) === norm(p.name) && norm(spec.value) === norm(p.value),
      ),
    ),
  );
  if (matching.length === 0) return null;
  return Math.min(...matching.map((s) => s.price));
}
