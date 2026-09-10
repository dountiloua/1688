import type { Lang } from "./session.js";

type Dict = Record<string, Record<Lang, string>>;

const STRINGS: Dict = {
  welcome: {
    ar: "👋 مرحباً بك في خدمة الاستيراد من 1688 و Alibaba إلى الجزائر!\n\n📎 أرسل رابط منتج من 1688.com أو alibaba.com وسنعطيك السعر بالدينار ونجهز طلبك.\n\n🌍 Français / English available — type /lang to switch language.",
    fr: "👋 Bienvenue dans le service d'import 1688 & Alibaba → Algérie !\n\n📎 Envoyez un lien produit 1688.com ou alibaba.com pour obtenir le prix en DZD.\n\nType /lang to switch language. /lang لتغيير اللغة.",
    en: "👋 Welcome to the 1688 & Alibaba → Algeria sourcing service!\n\n📎 Send a 1688.com or alibaba.com product link to get the DZD price and place an order.\n\nType /lang to switch language.",
  },
  chooseLang: {
    ar: "🌍 اختر اللغة / Choisissez la langue / Choose language:",
    fr: "🌍 اختر اللغة / Choisissez la langue / Choose language:",
    en: "🌍 اختر اللغة / Choisissez la langue / Choose language:",
  },
  langSet: {
    ar: "✅ تم ضبط اللغة على العربية.",
    fr: "✅ Langue réglée sur le français.",
    en: "✅ Language set to English.",
  },
  searching: {
    ar: "🔎 جاري البحث عن المنتج...",
    fr: "🔎 Recherche du produit en cours...",
    en: "🔎 Looking up the product...",
  },
  sendLinkHint: {
    ar: "📎 أرسل رابط منتج من 1688.com أو alibaba.com (مثال: https://detail.1688.com/offer/....).",
    fr: "📎 Envoyez un lien produit 1688.com ou alibaba.com.",
    en: "📎 Send a 1688.com or alibaba.com product link.",
  },
  badLink: {
    ar: "❌ هذا الرابط لا يبدو رابط 1688.com أو alibaba.com صحيحاً. تأكد من الرابط وأعد المحاولة.",
    fr: "❌ Ce lien ne ressemble pas à un lien 1688.com ou alibaba.com valide.",
    en: "❌ That doesn't look like a valid 1688.com or alibaba.com link.",
  },
  scrapeFailed: {
    ar: "❌ تعذر جلب بيانات المنتج من هذا الرابط. قد تكون الصفحة محمية أو تتطلب تسجيل الدخول. تحقق من الرابط وحاول مجدداً.",
    fr: "❌ Impossible de récupérer ce produit. La page est peut-être protégée ou nécessite une connexion.",
    en: "❌ Could not fetch this product. The page may be protected or require login.",
  },
  askName: {
    ar: "📝 ما هو الاسم الكامل؟",
    fr: "📝 Quel est votre nom complet ?",
    en: "📝 What is your full name?",
  },
  askQuantity: {
    ar: "🔢 كم قطعة تريد؟ (أرسل رقماً، مثال: 10)",
    fr: "🔢 Combien de pièces voulez-vous ? (envoyez un nombre, ex : 10)",
    en: "🔢 How many pieces do you want? (send a number, e.g. 10)",
  },
  askQuantityInvalid: {
    ar: "❌ أرسل رقماً صحيحاً للكمية (1 على الأقل).",
    fr: "❌ Envoyez un nombre valide (1 minimum).",
    en: "❌ Send a valid quantity number (at least 1).",
  },
  askWeight: {
    ar: "⚖️ ما هو الوزن التقديري الإجمالي بالكيلوغرام؟\n🚚 الشحن ≈ {FREIGHT} دج لكل 1kg.\nإذا لا تعرف الوزن، أرسل 0 وسيؤكده المشرف لاحقاً.",
    fr: "⚖️ Quel est le poids total estimé en kg ?\n🚚 Livraison ≈ {FREIGHT} DZD par 1kg.\nSi vous ne savez pas, envoyez 0.",
    en: "⚖️ What is the estimated total weight in kg?\n🚚 Shipping ≈ {FREIGHT} DZD per 1kg.\nIf you don't know, send 0.",
  },
  askWeightInvalid: {
    ar: "❌ أرسل الوزن رقماً بالكيلوغرام (مثال: 2.5) أو 0 إذا لا تعرف.",
    fr: "❌ Envoyez le poids en kg (ex : 2.5) ou 0 si vous ne savez pas.",
    en: "❌ Send the weight in kg (e.g. 2.5) or 0 if you don't know.",
  },
  askVariantColor: {
    ar: "🎨 اختر اللون: (اضغط زراً أو اكتب القيمة)",
    fr: "🎨 Choisissez la couleur : (touchez un bouton ou écrivez la valeur)",
    en: "🎨 Choose the color: (tap a button or type the value)",
  },
  askVariantSize: {
    ar: "📏 اختر المقاس: (اضغط زراً أو اكتب القيمة)",
    fr: "📏 Choisissez la taille : (touchez un bouton ou écrivez la valeur)",
    en: "📏 Choose the size: (tap a button or type the value)",
  },
  askVariantOther: {
    ar: "⚙️ اختر {NAME}: (اضغط زراً أو اكتب القيمة)",
    fr: "⚙️ Choisissez {NAME} : (touchez un bouton ou écrivez la valeur)",
    en: "⚙️ Choose {NAME}: (tap a button or type the value)",
  },
  variantInvalid: {
    ar: "❌ اختر من الخيارات المعروضة (زر أو كتابة دقيقة للقيمة).",
    fr: "❌ Choisissez parmi les options affichées.",
    en: "❌ Please pick from the options shown.",
  },
  askVariantAlloc: {
    ar: "🎨 وزّع {N} قطع على {OPT} — اضغط + / − أو اكتب الكمية مثل:\n{EX}\n✅ الحالي: {SUM}/{N}",
    fr: "🎨 Répartissez {N} pièces sur {OPT} — touchez +/− ou écrivez ex :\n{EX}\n✅ Actuel : {SUM}/{N}",
    en: "🎨 Split {N} pieces across {OPT} — tap +/− or type e.g.:\n{EX}\n✅ Current: {SUM}/{N}",
  },
  allocMismatch: {
    ar: "❌ المجموع الحالي {SUM} وليس {N} — عدّل الكميات ثم اضغط تم.",
    fr: "❌ Total actuel {SUM}, pas {N} — ajustez puis touchez Done.",
    en: "❌ Current total is {SUM}, not {N} — adjust then tap Done.",
  },
  variantDone: {
    ar: "✅ تم",
    fr: "✅ OK",
    en: "✅ Done",
  },
  askPhone: {
    ar: "📞 ما هو رقم الهاتف؟",
    fr: "📞 Quel est votre numéro de téléphone ?",
    en: "📞 What is your phone number?",
  },
  askWilaya: {
    ar: "📍 ما هي الولاية؟ (مثال: الجزائر، وهران، سطيف...)",
    fr: "📍 Quelle wilaya ? (ex : Alger, Oran, Sétif...)",
    en: "📍 Which wilaya? (e.g. Algiers, Oran, Sétif...)",
  },
  askPostal: {
    ar: "📮 ما هو الرمز البريدي؟ (5 أرقام، مثال: 16000)",
    fr: "📮 Quel est le code postal ? (5 chiffres, ex : 16000)",
    en: "📮 What is the postal code? (5 digits, e.g. 16000)",
  },
  askPostalInvalid: {
    ar: "❌ الرمز البريدي 5 أرقام (مثال: 16000). حاول مجدداً.",
    fr: "❌ Le code postal fait 5 chiffres (ex : 16000). Réessayez.",
    en: "❌ Postal code is 5 digits (e.g. 16000). Try again.",
  },
  askAddress: {
    ar: "🏠 ما هو عنوان التوصيل الكامل؟ (البلدية، الشارع، نقطة مرجعية...)",
    fr: "🏠 Quelle est l'adresse de livraison complète ?",
    en: "🏠 What is your full delivery address?",
  },
  cancelled: {
    ar: "🚫 تم إلغاء الطلب. أرسل رابطاً جديداً متى شئت.",
    fr: "🚫 Commande annulée. Envoyez un nouveau lien quand vous voulez.",
    en: "🚫 Order cancelled. Send a new link whenever you're ready.",
  },
  sessionExpired: {
    ar: "⚠️ انتهت الجلسة. أرسل رابط المنتج من جديد.",
    fr: "⚠️ Session expirée. Renvoyez le lien produit.",
    en: "⚠️ Session expired. Please resend the product link.",
  },
  orderReceived: {
    ar: "✅ تم استلام طلبك بنجاح!",
    fr: "✅ Commande reçue avec succès !",
    en: "✅ Your order has been received!",
  },
  approxNote: {
    ar: "💡 هذا سعر تقريبي — سيراجع المشرف طلبك ويرسل لك الفاتورة النهائية بالسعر النهائي قريباً.",
    fr: "💡 Ceci est un prix approximatif — un admin va vérifier votre commande et vous envoyer la facture finale.",
    en: "💡 This is an approximate price — an admin will review your order and send the final invoice shortly.",
  },
  paymentNote: {
    ar: "💳 تعليمات الدفع (تحويل بنكي / بريدي موب / الدفع عند الاستلام) سيرسلها إليك المشرف قريباً. الدفع الحقيقي عبر SATIM غير متوفر بعد.",
    fr: "💳 Les instructions de paiement (virement / BaridiMob / à la livraison) vous seront envoyées par un admin. L'intégration SATIM n'est pas encore en ligne.",
    en: "💳 Payment instructions (bank transfer / BaridiMob / cash on delivery) will be sent by an admin shortly. Live SATIM integration is not yet available.",
  },
  noOrders: {
    ar: "📦 لا توجد طلبات بعد. أرسل رابط منتج لبدء أول طلب!",
    fr: "📦 Aucune commande pour le moment. Envoyez un lien pour commencer !",
    en: "📦 No orders yet. Send a product link to start your first order!",
  },
};

export function t(lang: Lang, key: keyof typeof STRINGS): string {
  return STRINGS[key][lang];
}

export function formatDzd(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} DZD`;
}

/** "28 RMB" for 1688 orders, "$0.82 USD" for Alibaba orders. */
export function unitPriceLabel(priceRmb: number, currency: string): string {
  return currency === "USD" ? `$${priceRmb} USD` : `${priceRmb} RMB`;
}
