import type { Context, SessionFlavor } from "grammy";

export type Lang = "ar" | "fr" | "en";

export type ConversationStep =
  | "idle"
  | "awaiting_quantity"
  | "awaiting_weight"
  | "awaiting_name"
  | "awaiting_phone"
  | "awaiting_wilaya"
  | "awaiting_address";

export interface PendingProduct {
  url: string;
  title: string;
  priceRmb: number;
  imageUrl: string;
  moq: number | null;
  /** Unit price in DZD previewed for qty=1 (final total computed at order time). */
  unitDzd: number;
}

export interface SessionData {
  lang: Lang;
  step: ConversationStep;
  pending: PendingProduct | null;
  draftQuantity: number;
  draftWeightKg: number;
  draftName: string;
  draftPhone: string;
  draftWilaya: string;
}

export type MyContext = Context & SessionFlavor<SessionData>;

export function initialSession(): SessionData {
  return {
    lang: "ar",
    step: "idle",
    pending: null,
    draftQuantity: 1,
    draftWeightKg: 0,
    draftName: "",
    draftPhone: "",
    draftWilaya: "",
  };
}
