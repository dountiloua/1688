/**
 * 1688 scraping via the Oxylabs Realtime API (paid, reliable).
 *
 * Sends the product URL to https://realtime.oxylabs.io/v1/queries with
 * `source: "universal"` + JS rendering, receives the rendered HTML, then
 * parses it with the shared parser in `./parse1688.ts`.
 *
 * Implements the same interface as `./oneSixEightEight.ts` (Playwright),
 * so the two providers are interchangeable — see `./index.ts`.
 */
import {
  is1688Url,
  Product1688ScrapeError,
  type Scraped1688Product,
} from "./oneSixEightEight.js";
import { parse1688ProductHtml } from "./parse1688.js";

const REALTIME_ENDPOINT = "https://realtime.oxylabs.io/v1/queries";

interface OxylabsResult {
  content?: string;
  status_code?: number;
  url?: string;
  job_id?: string;
}

interface OxylabsResponse {
  results?: OxylabsResult[];
}

function getCredentials(): { username: string; password: string } {
  const username = (process.env.OXYLABS_USERNAME ?? "").trim();
  const password = (process.env.OXYLABS_PASSWORD ?? "").trim();
  if (!username || !password) {
    throw new Product1688ScrapeError(
      "Oxylabs provider selected but OXYLABS_USERNAME / OXYLABS_PASSWORD are not set.",
      "",
    );
  }
  return { username, password };
}

export async function scrape1688ViaOxylabs(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<Scraped1688Product> {
  const cleanUrl = url.trim();
  if (!is1688Url(cleanUrl)) {
    throw new Product1688ScrapeError(
      "URL is not a 1688.com product link.",
      cleanUrl,
    );
  }

  const { username, password } = getCredentials();
  const timeoutMs =
    opts?.timeoutMs ?? Number(process.env.OXYLABS_TIMEOUT_MS ?? 180000);
  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  let raw: string;
  let status: number;
  try {
    const res = await fetch(REALTIME_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        source: "universal",
        url: cleanUrl,
        render: "html", // 1688 prices are JS-rendered; needed
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    raw = await res.text();
  } catch (err) {
    throw new Product1688ScrapeError(
      `Oxylabs request failed: ${(err as Error)?.message ?? String(err)}`,
      cleanUrl,
      { cause: err },
    );
  }

  if (status === 401 || status === 403) {
    throw new Product1688ScrapeError(
      "Oxylabs rejected the credentials (401/403). Check OXYLABS_USERNAME / OXYLABS_PASSWORD.",
      cleanUrl,
    );
  }
  if (status === 402 || status === 429) {
    throw new Product1688ScrapeError(
      `Oxylabs rate limit / out of credits (HTTP ${status}). Try again later.`,
      cleanUrl,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Product1688ScrapeError(
      `Oxylabs API error (HTTP ${status}): ${raw.slice(0, 300)}`,
      cleanUrl,
    );
  }

  let data: OxylabsResponse;
  try {
    data = JSON.parse(raw) as OxylabsResponse;
  } catch (err) {
    throw new Product1688ScrapeError(
      "Oxylabs returned a non-JSON response.",
      cleanUrl,
      { cause: err },
    );
  }

  const result = data.results?.[0];
  if (!result?.content) {
    throw new Product1688ScrapeError(
      `Oxylabs returned no page content (page status ${result?.status_code ?? "unknown"}). The 1688 page may be blocking datacenter IPs.`,
      cleanUrl,
    );
  }
  if (result.status_code !== undefined && result.status_code !== 200) {
    throw new Product1688ScrapeError(
      `1688 page returned HTTP ${result.status_code} via Oxylabs. Check the link.`,
      cleanUrl,
    );
  }

  try {
    const parsed = parse1688ProductHtml(result.content, cleanUrl);
    return { ...parsed, url: cleanUrl };
  } catch (err) {
    throw new Product1688ScrapeError(
      `Could not extract product data from the Oxylabs HTML: ${(err as Error)?.message ?? String(err)}`,
      cleanUrl,
      { cause: err },
    );
  }
}
