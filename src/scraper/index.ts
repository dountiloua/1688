/**
 * Scraper provider dispatcher.
 *
 * `SCRAPER_PROVIDER` env selects the implementation:
 *   - "oxylabs"    -> Oxylabs Realtime API (paid, reliable, no browser needed)
 *   - "playwright" -> headless Chromium (free, may be blocked by 1688)
 *   - unset/empty  -> auto: Oxylabs when OXYLABS_USERNAME + OXYLABS_PASSWORD
 *                     are set, otherwise Playwright.
 *
 * Everything downstream (bot handlers) imports `scrape1688Product` from here
 * and stays provider-agnostic.
 */
import {
  is1688Url,
  Product1688ScrapeError,
  scrape1688Product as scrapeViaPlaywright,
  type Scraped1688Product,
} from "./oneSixEightEight.js";
import { scrape1688ViaOxylabs } from "./oxylabs.js";

export type ScraperProvider = "oxylabs" | "playwright";
export type { Scraped1688Product };
export { is1688Url, Product1688ScrapeError };

export function getScraperProvider(): ScraperProvider {
  const raw = (process.env.SCRAPER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "oxylabs" || raw === "playwright") return raw;
  if (process.env.OXYLABS_USERNAME && process.env.OXYLABS_PASSWORD) {
    return "oxylabs";
  }
  return "playwright";
}

export async function scrape1688Product(
  url: string,
): Promise<Scraped1688Product> {
  const provider = getScraperProvider();
  try {
    return provider === "oxylabs"
      ? await scrape1688ViaOxylabs(url)
      : await scrapeViaPlaywright(url);
  } catch (err) {
    // Don't retry obvious user errors (bad link, bad credentials) on the
    // other provider — that only burns time / API credits.
    const msg = (err as Error)?.message ?? "";
    if (/not a 1688\.com|credentials|401|403/i.test(msg)) throw err;
    // Fallback: if the primary provider fails and the other one is
    // configured, try it once before giving up.
    const fallback: ScraperProvider =
      provider === "oxylabs" ? "playwright" : "oxylabs";
    const fallbackReady =
      fallback === "playwright" ||
      (process.env.OXYLABS_USERNAME && process.env.OXYLABS_PASSWORD);
    if (fallbackReady) {
      console.warn(
        `Primary scraper (${provider}) failed, trying fallback (${fallback}):`,
        (err as Error)?.message ?? err,
      );
      return fallback === "oxylabs"
        ? await scrape1688ViaOxylabs(url)
        : await scrapeViaPlaywright(url);
    }
    throw err;
  }
}
