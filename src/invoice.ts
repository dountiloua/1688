/**
 * Final invoice message sent to the customer when the admin accepts
 * the order and locks the final price (panel or /accept command).
 */
import type { OrderRow } from "./db.js";
import { formatDzd } from "./i18n.js";
import { MINIMUM_DEPOSIT_DZD } from "./pricing.js";

export function invoiceMessage(order: OrderRow): string {
  const lines: (string | null)[] = [
    `🧾 فاتورة طلبك #${order.id} ✅`,
    ``,
    `📦 ${order.titleRaw.slice(0, 120)} ×${order.quantity || 1}`,
    order.variantSummary ? `🎨 ${order.variantSummary}` : null,
    `💰 السعر النهائي: ${formatDzd(order.totalAmountDzd)}`,
    order.totalAmountDzd <= MINIMUM_DEPOSIT_DZD
      ? `💳 الدفع الكامل مقدماً: ${formatDzd(order.depositAmountDzd)}`
      : `💳 العربون المطلوب الآن: ${formatDzd(order.depositAmountDzd)}\n💵 الباقي: ${formatDzd(order.remainingBalanceDzd)}`,
    `🏷️ Shipping Mark: ${order.shippingMark}`,
    `📌 الحالة: ${order.status}`,
    ``,
    `💳 تعليمات الدفع (تحويل بنكي / بريدي موب / الدفع عند الاستلام) سيرسلها إليك المشرف قريباً.`,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
