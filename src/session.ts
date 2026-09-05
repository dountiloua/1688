import type { Context, SessionFlavor } from "grammy";

export type Lang = "ar" | "fr" | "en";

export type ConversationStep =
  | "idle"
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
  fxRate: number;
  freight: number;
  total: number;
  deposit: number;
  remaining: number;
  requiresFullPayment: boolean;
}

export interface SessionData {
  lang: Lang;
  step: ConversationStep;
  pending: PendingProduct | null;
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
    draftName: "",
    draftPhone: "",
    draftWilaya: "",
  };
}
