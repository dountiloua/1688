/**
 * Alibaba.com scraping via the Oxylabs Realtime API (API-only in v1 —
 * the local headless browser path is tuned for 1688 page structures).
 *
 * Same interface as the 1688 providers: the unit price is returned in
 * SOURCE currency (USD here) with `currency: "USD"` so downstream pricing
 * skips the CNY leg. Variants (configurations) are not parsed in v1 —
 * products simply skip the allocation step, the same graceful path as
 * option-less 1688 pages.
 */
import {
  isAlibabaUrl,
  Product1688ScrapeError,
  type Scraped1688Product,
} from "./oneSixEightEight.js";
import { parseAlibabaProductHtml } from "./parseAlibaba.js";
import { fetchOxylabsHtml } from "./oxylabs.js";

export async function scrapeAlibabaProduct(
  url: string,
): Promise<Scraped1688Product> {
  const cleanUrl = url.trim();
  if (!isAlibabaUrl(cleanUrl)) {
    throw new Product1688ScrapeError(
      "URL is not an alibaba.com product link.",
      cleanUrl,
    );
  }

  const html = await fetchOxylabsHtml(cleanUrl);

  try {
    const parsed = parseAlibabaProductHtml(html, cleanUrl);
    return {
      title: parsed.title,
      priceRmb: parsed.priceUsd,
      currency: "USD",
      imageUrl: parsed.imageUrl,
      moq: parsed.moq,
      variants: [],
      skus: [],
      tiers: parsed.tiers.map((t) => ({ minQty: t.minQty, price: t.price })),
      url: cleanUrl,
    };
  } catch (err) {
    throw new Product1688ScrapeError(
      `Could not extract product data from the Alibaba page: ${(err as Error)?.message ?? String(err)}`,
      cleanUrl,
      { cause: err },
    );
  }
}
