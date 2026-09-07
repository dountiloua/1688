import type { PriceTier, SkuEntry, VariantOption } from "./scraper/parse1688.js";
import type { Context, SessionFlavor } from "grammy";

export type Lang = "ar" | "fr" | "en";

export type ConversationStep =
  | "idle"
  | "awaiting_variant"
  | "awaiting_quantity"
  | "awaiting_weight"
  | "awaiting_name"
  | "awaiting_phone"
  | "awaiting_wilaya"
  | "awaiting_postal"
  | "awaiting_address";

export interface PendingProduct {
  url: string;
  title: string;
  priceRmb: number;
  imageUrl: string;
  moq: number | null;
  /** Unit price in DZD previewed for qty=1 (final total computed at order time). */
  unitDzd: number;
  variants: VariantOption[];
  skus: SkuEntry[];
  tiers: PriceTier[];
  /** Unit RMB after variant selection (defaults to priceRmb). */
  resolvedPriceRmb: number;
}

export interface SessionData {
  lang: Lang;
  step: ConversationStep;
  pending: PendingProduct | null;
  draftVariantIdx: number;
  draftPicks: { name: string; value: string; qty: number }[];
  /** Live allocation for the current option: value → pieces (sums to draftQuantity). */
  draftAlloc: Record<string, number>;
  /** Message id of the live allocation keyboard (for typed-input re-render). */
  draftAllocMsgId: number | null;
  draftQuantity: number;
  draftWeightKg: number;
  draftName: string;
  draftPhone: string;
  draftWilaya: string;
  draftPostalCode: string;
}

export type MyContext = Context & SessionFlavor<SessionData>;

export function initialSession(): SessionData {
  return {
    lang: "ar",
    step: "idle",
    pending: null,
    draftVariantIdx: 0,
    draftPicks: [],
    draftAlloc: {},
    draftAllocMsgId: null,
    draftQuantity: 1,
    draftWeightKg: 0,
    draftName: "",
    draftPhone: "",
    draftWilaya: "",
    draftPostalCode: "",
  };
}
