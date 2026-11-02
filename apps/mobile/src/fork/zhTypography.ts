// fork: Simplified Chinese text sizes. Han glyphs fill the whole em box while Latin lowercase is
// about half as tall, so the same size reads larger and denser in Chinese. Applied where the
// shared size roles are resolved, on top of the user's base font size. Line heights stay as they
// are so rows keep their height; the web counterpart is apps/web/src/fork/zhTypography.css.
import type { UiLocale } from "@t3tools/client-runtime/i18n";

import { MOBILE_TYPOGRAPHY } from "../lib/typography";

type Role = keyof typeof MOBILE_TYPOGRAPHY;

/** Chinese sizes at the default base size; nothing below 11.5, the smallest Han that stays legible. */
const ZH_FONT_SIZE: Readonly<Record<Role, number>> = {
  micro: 11.5,
  caption: 11.5,
  label: 12,
  footnote: 13,
  body: 15,
  headline: 17,
  title: 20,
  largeTitle: 24,
  display: 28,
};

/** A role's size after the base font size scales it. English keeps whole points, as upstream does. */
export function scaledLocalizedFontSize(role: Role, scale: number, locale: UiLocale): number {
  if (locale !== "zh-Hans") return Math.round(MOBILE_TYPOGRAPHY[role].fontSize * scale);
  return Math.round(ZH_FONT_SIZE[role] * scale * 2) / 2;
}

/** Chat Markdown at the default base size in Chinese; code blocks keep their own size setting. */
const ZH_MARKDOWN_FONT_SIZE = { s: 13, h1: 20, h2: 18, h3: 16, h4: 14 } as const;

/** A Markdown size after the base font size scales it, or null to keep the upstream table. */
export function scaledLocalizedMarkdownFontSize(
  key: keyof typeof ZH_MARKDOWN_FONT_SIZE,
  scale: number,
  locale: UiLocale,
): number | null {
  if (locale !== "zh-Hans") return null;
  return Math.round(ZH_MARKDOWN_FONT_SIZE[key] * scale * 2) / 2;
}
