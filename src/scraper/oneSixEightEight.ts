/**
 * 1688.com product scraper — isolated, swappable module.
 *
 * To replace with a paid scraping API later, keep the same exports:
 *   - `Scraped1688Product` interface
 *   - `Product1688ScrapeError` class
 *   - `scrape1688Product(url)` function
 * and reimplement the internals behind that interface.
 */
import { chromium, type Browser } from "playwright";
import {
  extractVariants,
  type PriceTier,
  type SkuEntry,
  type VariantOption,
} from "./parse1688.js";

export interface Scraped1688Product {
  title: string;
  priceRmb: number;
  imageUrl: string;
  moq: number | null;
  variants: VariantOption[];
  skus: SkuEntry[];
  tiers: PriceTier[];
  url: string;
}

export class Product1688ScrapeError extends Error {
  readonly url: string;
  constructor(message: string, url: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "Product1688ScrapeError";
    this.url = url;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  return sharedBrowser;
}

export async function closeScraper(): Promise<void> {
  try {
    await sharedBrowser?.close();
  } catch {
    // ignore close errors during shutdown
  } finally {
    sharedBrowser = null;
  }
}

function parseFirstNumber(text: string): number | null {
  // Handles "¥ 12.5-18.9", "12.50", "￥9.9起", "9,999.00"
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMoq(text: string): number | null {
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function is1688Url(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return /(^|\.)1688\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scrape a 1688.com product page. Takes the lowest tier price when a
 * price range / ladder is shown. Throws Product1688ScrapeError on failure.
 */
export async function scrape1688Product(
  url: string,
  opts?: { timeoutMs?: number; maxRetries?: number },
): Promise<Scraped1688Product> {
  const cleanUrl = url.trim();
  if (!is1688Url(cleanUrl)) {
    throw new Product1688ScrapeError(
      "URL is not a 1688.com product link.",
      cleanUrl,
    );
  }

  const timeoutMs = opts?.timeoutMs ?? Number(process.env.SCRAPER_TIMEOUT_MS ?? 30000);
  const maxRetries = opts?.maxRetries ?? 2;
  const navDelayMs = Number(process.env.SCRAPER_NAV_DELAY_MS ?? 1500);

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff before retry (rate-limit friendly)
      await sleep(navDelayMs * Math.pow(2, attempt - 1));
    }
    try {
      return await scrapeOnce(cleanUrl, timeoutMs, navDelayMs);
    } catch (err) {
      lastError = err;
      if (err instanceof Product1688ScrapeError && err.message.includes("not a 1688.com")) {
        throw err;
      }
      // otherwise retry
    }
  }

  throw new Product1688ScrapeError(
    "Could not extract product data from this 1688 link. The page may be blocked, require login, or have an unsupported layout. Please check the link and try again.",
    cleanUrl,
    { cause: lastError },
  );
}

async function scrapeOnce(
  url: string,
  timeoutMs: number,
  navDelayMs: number,
): Promise<Scraped1688Product> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  const page = await context.newPage();
  try {
    // Speed: we parse text/JSON only — images, fonts and media just slow us down.
    // (Aborting requests does NOT remove <img src> attributes from the DOM,
    // so image extraction keeps working.)
    // Speed: we parse text/JSON only — images, fonts and media just slow us down.
    // (Aborting requests does NOT remove <img src> attributes from the DOM,
    // so image extraction keeps working.)
    await page.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (rt === "image" || rt === "media" || rt === "font") {
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await sleep(navDelayMs);
    // Let price widgets hydrate
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const pickText = (selectors: string[]): string | null => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const text = el?.textContent?.trim();
          if (text) return text;
        }
        return null;
      };
      const pickAttr = (selectors: string[], attr: string): string | null => {
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLImageElement | null;
          const val = el?.getAttribute(attr)?.trim();
          if (val) return val;
        }
        return null;
      };
      const bodyText = document.body.innerText ?? "";

      const title =
        pickText([
          "h1.title",
          ".title-text",
          "[class*='title'] h1",
          "h1",
          "title",
        ]) ??
        (document.title || "").trim() ??
        "";

      // Price: try dedicated selectors first, then fall back to ¥ regex over body
      let priceText: string | null = pickText([
        ".price-now",
        ".price-original",
        "[class*='price'] .value",
        "[class*='Price']",
        ".detail-price",
        ".mod-detail-price",
      ]);
      if (!priceText) {
        const m = bodyText.match(/[¥￥]\s?[\d,]+(?:\.\d+)?(?:\s*[-~–]\s*[¥￥]?\s?[\d,]+(?:\.\d+)?)?/);
        priceText = m ? m[0] : null;
      }

      let imageUrl: string | null = pickAttr(
        [".detail-gallery img", ".gallery img", "[class*='gallery'] img", ".main-img", "img"],
        "src",
      );
      if (!imageUrl) {
        imageUrl = pickAttr(["img"], "data-src");
      }

      // MOQ hints: 起批量 / 最小起订 / 起订量
      let moqText: string | null = null;
      const moqMatch = bodyText.match(/(?:起批量|最小起订|起订量|MOQ)[^\d]{0,10}(\d[\d,]*)/);
      if (moqMatch) moqText = moqMatch[1];

      return { title, priceText, imageUrl, moqText };
    });

    if (!data.title) {
      throw new Product1688ScrapeError(
        "Product page loaded but no title was found (unsupported layout).",
        url,
      );
    }
    if (!data.priceText) {
      throw new Product1688ScrapeError(
        "Product page loaded but no price was found (may require login or unsupported layout).",
        url,
      );
    }

    const priceRmb = parseFirstNumber(data.priceText);
    if (priceRmb === null) {
      throw new Product1688ScrapeError(
        `Could not parse a numeric price from "${data.priceText}".`,
        url,
      );
    }

    let imageUrl = (data.imageUrl ?? "").trim();
    if (imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
    if (!/^https?:\/\//i.test(imageUrl)) imageUrl = "";

    const moq = data.moqText ? parseMoq(data.moqText) : null;

    // Variants come from the shared HTML parser (same as the API path).
    // Optional: never fail a scrape because of them.
    let variants: VariantOption[] = [];
    let skus: SkuEntry[] = [];
    let tiers: PriceTier[] = [];
    try {
      const html = await page.content();
      const v = extractVariants(html);
      variants = v.options;
      skus = v.skus;
      tiers = v.tiers;
    } catch {
      // ignore
    }

    return { title: data.title.slice(0, 500), priceRmb, imageUrl, moq, variants, skus, tiers, url };
  } catch (err) {
    if (err instanceof Product1688ScrapeError) throw err;
    throw new Product1688ScrapeError(
      `Failed to load or parse the 1688 product page: ${(err as Error)?.message ?? String(err)}`,
      url,
      { cause: err },
    );
  } finally {
    await context.close().catch(() => undefined);
  }
}
