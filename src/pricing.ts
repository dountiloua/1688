/**
 * Pricing engine (USD-based).
 *
 *   unitUsd      = priceRmb / cnyPerUsd        (live CNY→USD, cached, admin-overridable)
 *   unitDzd      = round(unitUsd * usdRateDzd)  (default 255 DZD per 1 USD)
 *   productTotal = unitDzd * quantity
 *   freightDzd   = round(weightKg * freightPerKgDzd)  (default 5000 DZD / kg)
 *   total        = productTotal + freightDzd
 *
 * Deposit rule: totals ≤ 10000 DZD are paid fully upfront,
 * otherwise 10000 DZD deposit + remainder later.
 */

export const MINIMUM_DEPOSIT_DZD = 10000;
export const DEFAULT_USD_RATE_DZD = 255;
export const DEFAULT_FREIGHT_PER_KG_DZD = 5000;

/** Legacy (pre-USD) settings keys — kept so old installs still migrate. */
export const DEFAULT_FX_RATE_RMB_DZD = 38;
export const DEFAULT_FREIGHT_ESTIMATE_DZD = 1500;

export interface PriceInput {
  priceRmb: number;
  quantity: number;
  weightKg: number;
  cnyPerUsd: number;
  usdRateDzd: number;
  freightPerKgDzd: number;
}

export interface PriceQuote {
  unitPriceRmb: number;
  quantity: number;
  unitPriceUsd: number;
  unitPriceDzd: number;
  productTotalDzd: number;
  weightKg: number;
  freightDzd: number;
  totalAmountDzd: number;
  depositAmountDzd: number;
  remainingBalanceDzd: number;
  requiresFullPaymentUpfront: boolean;
  cnyPerUsd: number;
  usdRateDzd: number;
  freightPerKgDzd: number;
}

export function quotePrice(input: PriceInput): PriceQuote {
  const quantity = Math.max(1, Math.floor(input.quantity));
  const weightKg = Math.max(0, input.weightKg);
  const unitPriceUsd = input.priceRmb / input.cnyPerUsd;
  const unitPriceDzd = Math.round(unitPriceUsd * input.usdRateDzd);
  const productTotalDzd = unitPriceDzd * quantity;
  const freightDzd = Math.round(weightKg * input.freightPerKgDzd);
  const totalAmountDzd = productTotalDzd + freightDzd;

  if (totalAmountDzd <= MINIMUM_DEPOSIT_DZD) {
    return {
      unitPriceRmb: input.priceRmb,
      quantity,
      unitPriceUsd,
      unitPriceDzd,
      productTotalDzd,
      weightKg,
      freightDzd,
      totalAmountDzd,
      depositAmountDzd: totalAmountDzd,
      remainingBalanceDzd: 0,
      requiresFullPaymentUpfront: true,
      cnyPerUsd: input.cnyPerUsd,
      usdRateDzd: input.usdRateDzd,
      freightPerKgDzd: input.freightPerKgDzd,
    };
  }

  return {
    unitPriceRmb: input.priceRmb,
    quantity,
    unitPriceUsd,
    unitPriceDzd,
    productTotalDzd,
    weightKg,
    freightDzd,
    totalAmountDzd,
    depositAmountDzd: MINIMUM_DEPOSIT_DZD,
    remainingBalanceDzd: totalAmountDzd - MINIMUM_DEPOSIT_DZD,
    requiresFullPaymentUpfront: false,
    cnyPerUsd: input.cnyPerUsd,
    usdRateDzd: input.usdRateDzd,
    freightPerKgDzd: input.freightPerKgDzd,
  };
}
