/**
 * CNY→USD rate provider.
 *
 * Modes (setting `cny_per_usd_mode`):
 *   - "manual": uses `cny_per_usd_manual` set by the admin (panel / /setcny)
 *   - "auto" (default): fetches a live rate from free no-key APIs,
 *     cached in settings for 12h to avoid hammering the API per order.
 *
 * If the live fetch fails, the last cached value is reused (marked stale).
 * Throws only when there is no usable rate at all.
 */
import { getSetting, setSetting } from "./db.js";

export const CNY_CACHE_TTL_MS = 12 * 3600 * 1000;

export type CnyRateSource = "manual" | "live" | "cache" | "stale-cache";

export interface CnyRate {
  /** How many CNY buy 1 USD (e.g. ~7.2). */
  rate: number;
  source: CnyRateSource;
  updatedAt: string | null;
}

function parsePositive(raw: string | null): number | null {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getCnyMode(): "auto" | "manual" {
  return getSetting("cny_per_usd_mode") === "manual" ? "manual" : "auto";
}

export async function getCnyPerUsd(): Promise<CnyRate> {
  if (getCnyMode() === "manual") {
    const manual = parsePositive(getSetting("cny_per_usd_manual"));
    if (manual !== null) {
      return { rate: manual, source: "manual", updatedAt: null };
    }
    // Manual mode with no value falls through to live.
  }

  const cached = parsePositive(getSetting("cny_per_usd_cached"));
  const cachedAt = Number(getSetting("cny_per_usd_cached_at") ?? 0);
  const updatedAt = cachedAt > 0 ? new Date(cachedAt).toISOString() : null;
  const fresh =
    cached !== null && Date.now() - cachedAt < CNY_CACHE_TTL_MS;

  if (fresh && cached !== null) {
    return { rate: cached, source: "cache", updatedAt };
  }

  try {
    const live = await fetchLiveCnyPerUsd();
    setSetting("cny_per_usd_cached", String(live));
    setSetting("cny_per_usd_cached_at", String(Date.now()));
    return {
      rate: live,
      source: "live",
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (cached !== null) {
      console.warn("Live CNY rate fetch failed, using stale cache:", err);
      return { rate: cached, source: "stale-cache", updatedAt };
    }
    throw new Error(
      `No CNY→USD rate available (live fetch failed and nothing cached): ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

/** Returns CNY per 1 USD using free no-key APIs (frankfurter → er-api). */
export async function fetchLiveCnyPerUsd(): Promise<number> {
  const errors: string[] = [];

  // 1. Frankfurter (ECB reference rates, free, no key)
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=CNY", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      rates?: Record<string, number>;
    };
    const usdPerCny = data.rates?.USD;
    const rate = usdPerCny ? 1 / usdPerCny : NaN;
    if (isSaneCnyRate(rate)) return rate;
    throw new Error(`implausible rate ${rate}`);
  } catch (err) {
    errors.push(`frankfurter: ${(err as Error)?.message ?? String(err)}`);
  }

  // 2. Open ER-API (free, no key)
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/CNY", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };
    const usdPerCny = data.rates?.USD;
    const rate = usdPerCny ? 1 / usdPerCny : NaN;
    if (isSaneCnyRate(rate)) return rate;
    throw new Error(`implausible rate ${rate}`);
  } catch (err) {
    errors.push(`er-api: ${(err as Error)?.message ?? String(err)}`);
  }

  throw new Error(errors.join(" | "));
}

/** CNY per USD has lived roughly between 6 and 9 for a decade. */
function isSaneCnyRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 5 && rate <= 12;
}
