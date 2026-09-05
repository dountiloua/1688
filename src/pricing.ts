/**
 * Pricing engine — DO NOT change the formula.
 * Validated elsewhere in the project.
 */

export const DEFAULT_FX_RATE_RMB_DZD = 38;
export const FX_VOLATILITY_BUFFER = 1.05;
export const PLATFORM_MARGIN = 1.1;
export const MINIMUM_DEPOSIT_DZD = 10000;
export const DEFAULT_FREIGHT_ESTIMATE_DZD = 1500;

export interface PriceInput {
  priceRmb: number;
  fxRateRmbDzd: number;
  estFreightDzd: number;
}

export interface PriceQuote {
  productCostDzd: number;
  totalAmountDzd: number;
  depositAmountDzd: number;
  remainingBalanceDzd: number;
  requiresFullPaymentUpfront: boolean;
  fxRateRmbDzd: number;
  estFreightDzd: number;
}

export function quotePrice(input: PriceInput): PriceQuote {
  const productCostDzd = input.priceRmb * input.fxRateRmbDzd;
  const totalAmountDzd = Math.round(
    productCostDzd * FX_VOLATILITY_BUFFER * PLATFORM_MARGIN +
      input.estFreightDzd,
  );

  if (totalAmountDzd <= MINIMUM_DEPOSIT_DZD) {
    return {
      productCostDzd,
      totalAmountDzd,
      depositAmountDzd: totalAmountDzd,
      remainingBalanceDzd: 0,
      requiresFullPaymentUpfront: true,
      fxRateRmbDzd: input.fxRateRmbDzd,
      estFreightDzd: input.estFreightDzd,
    };
  }

  return {
    productCostDzd,
    totalAmountDzd,
    depositAmountDzd: MINIMUM_DEPOSIT_DZD,
    remainingBalanceDzd: totalAmountDzd - MINIMUM_DEPOSIT_DZD,
    requiresFullPaymentUpfront: false,
    fxRateRmbDzd: input.fxRateRmbDzd,
    estFreightDzd: input.estFreightDzd,
  };
}
