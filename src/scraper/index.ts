/**
 * Scraper provider dispatcher — LOCAL FIRST, API fallback.
 *
 * Order is controlled by `SCRAPER_ORDER` (default "local,api"):
 *   - "local,api" -> try headless Chromium first (free, fastest when it
 *                    works), fall back to the Oxylabs API on failure/timeout
 *   - "api,local" -> Oxylabs first, local fallback
 *   - "local"     -> local only (no API spend, fails if 1688 blocks us)
 *   - "api"       -> Oxylabs only (no browser needed)
 *
 * Legacy `SCRAPER_PROVIDER` is still honoured: "oxylabs"/"api" means
 * "api,local", "playwright"/"local" means "local,api".
 *
 * The local attempt races against `LOCAL_TIMEOUT_MS` (default 45s) so a
 * stuck page never keeps the Telegram user waiting — we fail over to the
 * API instead of hanging.
 *
 * Everything downstream imports `scrape1688Product` from here and stays
 * provider-agnostic.
 */
import {
  is1688Url,
  isAlibabaUrl,
  Product1688ScrapeError,
  scrape1688Product as scrapeViaPlaywright,
  type Scraped1688Product,
} from "./oneSixEightEight.js";
import { scrape1688ViaOxylabs } from "./oxylabs.js";
import { scrapeAlibabaProduct } from "./alibaba.js";

export type ScraperProvider = "local" | "playwright" | "oxylabs" | "api";
export type { Scraped1688Product };
export { is1688Url, isAlibabaUrl, Product1688ScrapeError };

type Engine = "local" | "api";

function resolveOrder(): Engine[] {
  const raw = (process.env.SCRAPER_ORDER ?? "").trim().toLowerCase();
  if (raw) {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p === "local" || p === "playwright" || p === "api" || p === "oxylabs")
      .map((p): Engine => (p === "api" || p === "oxylabs" ? "api" : "local"));
    const deduped = [...new Set(parts)];
    if (deduped.length > 0) return deduped;
  }
  // Legacy single-provider env
  const legacy = (process.env.SCRAPER_PROVIDER ?? "").trim().toLowerCase();
  if (legacy === "oxylabs" || legacy === "api") return ["api", "local"];
  if (legacy === "playwright" || legacy === "local") return ["local", "api"];
  // Auto: local first when Oxylabs creds exist (free attempt before spend),
  // else local anyway (it fast-fails without a browser binary → api next
  // if creds exist, otherwise the local error surfaces).
  return ["local", "api"];
}

/** Back-compat: primary engine name. */
export function getScraperProvider(): ScraperProvider {
  return resolveOrder()[0] === "api" ? "oxylabs" : "playwright";
}

function localTimeoutMs(): number {
  const n = Number(process.env.LOCAL_TIMEOUT_MS ?? 45000);
  return Number.isFinite(n) && n >= 5000 ? n : 45000;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function apiReady(): boolean {
  return Boolean(process.env.OXYLABS_USERNAME && process.env.OXYLABS_PASSWORD);
}

export async function scrape1688Product(
  url: string,
): Promise<Scraped1688Product> {
  const clean = url.trim();

  // Alibaba: API-only in v1 (local browser path is 1688-tuned).
  if (isAlibabaUrl(clean)) {
    if (!apiReady()) {
      throw new Product1688ScrapeError(
        "Alibaba links need the Oxylabs API (OXYLABS_USERNAME / OXYLABS_PASSWORD are not set).",
        clean,
      );
    }
    const started = Date.now();
    try {
      const result = await scrapeAlibabaProduct(clean);
      console.log(
        `Scrape OK via api (alibaba) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      return result;
    } catch (err) {
      if (err instanceof Product1688ScrapeError) throw err;
      throw new Product1688ScrapeError(
        `Alibaba scrape failed: ${(err as Error)?.message ?? String(err)}`,
        clean,
        { cause: err },
      );
    }
  }

  if (!is1688Url(clean)) {
    throw new Product1688ScrapeError(
      "URL is not a 1688.com or alibaba.com product link.",
      clean,
    );
  }

  const order = resolveOrder();
  let lastError: unknown = null;

  for (const engine of order) {
    if (engine === "api" && !apiReady()) continue;
    const started = Date.now();
    try {
      const result =
        engine === "api"
          ? await scrape1688ViaOxylabs(url)
          : await withTimeout(scrapeViaPlaywright(url), localTimeoutMs(), "Local scrape");
      console.log(
        `Scrape OK via ${engine} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      return result;
    } catch (err) {
      lastError = err;
      console.warn(
        `Scrape via ${engine} failed in ${((Date.now() - started) / 1000).toFixed(1)}s:`,
        (err as Error)?.message ?? err,
      );
      // Fail fast on user errors only when no fallback remains.
      const msg = (err as Error)?.message ?? "";
      const remaining = order.slice(order.indexOf(engine) + 1);
      const fallbackExists = remaining.some(
        (e) => e === "local" || (e === "api" && apiReady()),
      );
      if (/not a 1688\.com/i.test(msg) || !fallbackExists) throw err;
    }
  }

  if (lastError instanceof Product1688ScrapeError) throw lastError;
  throw new Product1688ScrapeError(
    `All scrapers failed: ${(lastError as Error)?.message ?? String(lastError)}`,
    url.trim(),
    { cause: lastError },
  );
}
