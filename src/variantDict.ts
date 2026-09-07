/**
 * Static offline dictionary for 1688 variant values (Chinese → ar/fr/en).
 *
 * Deliberately NOT an LLM or translation API: it works offline, costs
 * nothing, adds no latency, and keeps working wherever the bot runs.
 * Unknown values fall back to the original text untouched.
 */
import type { Lang } from "./session.js";

interface Tr {
  ar: string;
  fr: string;
  en: string;
}

const COLORS: Record<string, Tr> = {
  白色: { ar: "أبيض", fr: "blanc", en: "white" },
  奶白色: { ar: "أبيض حليبي", fr: "blanc cassé", en: "off-white" },
  米白色: { ar: "أبيض عاجي", fr: "blanc cassé", en: "off-white" },
  黑色: { ar: "أسود", fr: "noir", en: "black" },
  灰色: { ar: "رمادي", fr: "gris", en: "gray" },
  浅灰: { ar: "رمادي فاتح", fr: "gris clair", en: "light gray" },
  深灰: { ar: "رمادي غامق", fr: "gris foncé", en: "dark gray" },
  红色: { ar: "أحمر", fr: "rouge", en: "red" },
  正红: { ar: "أحمر صريح", fr: "rouge vif", en: "true red" },
  大红: { ar: "أحمر فاقع", fr: "rouge vif", en: "bright red" },
  深红: { ar: "أحمر غامق", fr: "rouge foncé", en: "dark red" },
  枣红: { ar: "أحمر داكن", fr: "rouge foncé", en: "dark red" },
  酒红色: { ar: "عنابي", fr: "bordeaux", en: "burgundy" },
  玫红色: { ar: "فوشي", fr: "fuchsia", en: "fuchsia" },
  蓝色: { ar: "أزرق", fr: "bleu", en: "blue" },
  浅蓝: { ar: "أزرق فاتح", fr: "bleu clair", en: "light blue" },
  深蓝: { ar: "أزرق غامق", fr: "bleu foncé", en: "dark blue" },
  天蓝色: { ar: "أزرق سماوي", fr: "bleu ciel", en: "sky blue" },
  藏青色: { ar: "كحلي", fr: "bleu marine", en: "navy" },
  藏青: { ar: "كحلي", fr: "bleu marine", en: "navy" },
  宝蓝色: { ar: "أزرق ملكي", fr: "bleu roi", en: "royal blue" },
  湖蓝: { ar: "أزرق مائي", fr: "bleu lac", en: "lake blue" },
  绿色: { ar: "أخضر", fr: "vert", en: "green" },
  浅绿: { ar: "أخضر فاتح", fr: "vert clair", en: "light green" },
  深绿: { ar: "أخضر غامق", fr: "vert foncé", en: "dark green" },
  墨绿色: { ar: "أخضر داكن", fr: "vert foncé", en: "dark green" },
  军绿色: { ar: "زيتي", fr: "vert armée", en: "army green" },
  果绿: { ar: "أخضر تفاحي", fr: "vert pomme", en: "apple green" },
  荧光绿: { ar: "أخضر نيون", fr: "vert néon", en: "neon green" },
  黄色: { ar: "أصفر", fr: "jaune", en: "yellow" },
  奶黄: { ar: "أصفر كريمي", fr: "jaune crème", en: "cream yellow" },
  粉色: { ar: "وردي", fr: "rose", en: "pink" },
  浅粉: { ar: "وردي فاتح", fr: "rose clair", en: "light pink" },
  紫色: { ar: "بنفسجي", fr: "violet", en: "purple" },
  浅紫: { ar: "بنفسجي فاتح", fr: "violet clair", en: "light purple" },
  深紫: { ar: "بنفسجي غامق", fr: "violet foncé", en: "dark purple" },
  棕色: { ar: "بني", fr: "marron", en: "brown" },
  咖啡色: { ar: "بني", fr: "marron", en: "coffee brown" },
  深咖色: { ar: "بني غامق", fr: "marron foncé", en: "dark coffee" },
  深咖: { ar: "بني غامق", fr: "marron foncé", en: "dark coffee" },
  浅咖色: { ar: "بني فاتح", fr: "marron clair", en: "light coffee" },
  巧克力色: { ar: "شوكولاتة", fr: "marron chocolat", en: "chocolate" },
  驼色: { ar: "جملي", fr: "camel", en: "camel" },
  卡其色: { ar: "كاكي", fr: "kaki", en: "khaki" },
  米色: { ar: "بيج", fr: "beige", en: "beige" },
  肤色: { ar: "لون البشرة", fr: "nude", en: "nude" },
  橙色: { ar: "برتقالي", fr: "orange", en: "orange" },
  橘色: { ar: "برتقالي", fr: "orange", en: "orange" },
  金色: { ar: "ذهبي", fr: "doré", en: "gold" },
  银色: { ar: "فضي", fr: "argenté", en: "silver" },
  黑白: { ar: "أسود-أبيض", fr: "noir-blanc", en: "black-white" },
  花色: { ar: "متعدد الألوان", fr: "multicolore", en: "multicolor" },
  彩色: { ar: "ملون", fr: "coloré", en: "colorful" },
  透明: { ar: "شفاف", fr: "transparent", en: "transparent" },
  迷彩: { ar: "مموه", fr: "camouflage", en: "camouflage" },
  纯色: { ar: "سادة", fr: "uni", en: "solid" },
  条纹: { ar: "مخطط", fr: "rayé", en: "striped" },
  格子: { ar: "مربعات", fr: "à carreaux", en: "checkered" },
  格纹: { ar: "مربعات", fr: "à carreaux", en: "checkered" },
  印花: { ar: "مطبوع", fr: "imprimé", en: "printed" },
  碎花: { ar: "زهور صغيرة", fr: "à petites fleurs", en: "floral" },
  波点: { ar: "منقط", fr: "à pois", en: "polka dot" },
};

const SIZES: Record<string, Tr> = {
  均码: { ar: "مقاس موحد", fr: "taille unique", en: "one size" },
  大码: { ar: "مقاس كبير", fr: "grande taille", en: "plus size" },
  加大码: { ar: "مقاس كبير", fr: "grande taille", en: "plus size" },
};

/** Modifier prefix → translation (used when the base color is known). */
const MODIFIERS: Record<string, Tr> = {
  深: { ar: "غامق", fr: "foncé", en: "dark" },
  浅: { ar: "فاتح", fr: "clair", en: "light" },
  亮: { ar: "ساطع", fr: "vif", en: "bright" },
  暗: { ar: "داكن", fr: "foncé", en: "dark" },
  艳: { ar: "فاقع", fr: "vif", en: "vivid" },
  淡: { ar: "خفيف", fr: "clair", en: "pale" },
  墨: { ar: "غامق", fr: "foncé", en: "dark" },
};

function compose(
  lang: Lang,
  mod: Tr,
  base: Tr,
): string {
  // Arabic/French adjectives follow the noun; English precedes it.
  if (lang === "ar") return `${base.ar} ${mod.ar}`;
  if (lang === "fr") return `${base.fr} ${mod.fr}`;
  return `${mod.en} ${base.en}`;
}

/**
 * Translate a variant value for display. Returns the original text when
 * unknown — never throws, never calls any API.
 */
export function translateVariant(
  value: string,
  lang: Lang,
): string {
  const v = value.trim();
  if (!v) return value;
  if (COLORS[v]) return COLORS[v][lang];
  if (SIZES[v]) return SIZES[v][lang];
  // Modifier + base composition: 深咖色 → dark + coffee, 浅蓝 → light + blue.
  for (const mod of Object.keys(MODIFIERS)) {
    if (v.startsWith(mod) && v.length > mod.length + 1) {
      const base = v.slice(mod.length);
      if (COLORS[base]) return compose(lang, MODIFIERS[mod], COLORS[base]);
    }
  }
  return value;
}

/** Translate a full picks list for customer-facing messages. */
export function translatePicks(
  picks: { name: string; value: string; qty?: number }[],
  lang: Lang,
): string {
  return picks
    .map((p) =>
      p.qty !== undefined && p.qty > 1
        ? `${translateVariant(p.value, lang)}×${p.qty}`
        : translateVariant(p.value, lang),
    )
    .join(" / ");
}
