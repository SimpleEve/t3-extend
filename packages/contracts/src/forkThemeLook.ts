import * as Schema from "effect/Schema";

import { ChatWidth } from "./settings.ts";

// fork: a theme's "look" is everything about it that is not a color: fonts, shape, density,
// shadow, chat width and panel glass. Every field is optional and bounded; a client that does
// not know the field ignores it, so mobile keeps working with themes that carry one.

/** Whole numbers, so a theme file never depends on how a float is printed. */
export const THEME_LOOK_LIMITS = {
  /** Corner radius in px at the default root font size. */
  radius: { min: 0, max: 24, step: 1, default: 8 },
  /** Percent of the default spacing scale; below 100 is tighter. */
  density: { min: 80, max: 120, step: 5, default: 100 },
  /** Percent of the default shadow strength. */
  shadow: { min: 0, max: 200, step: 10, default: 100 },
  /** Percent translucency of panels. Only has an effect while a background image is shown. */
  glass: { min: 0, max: 100, step: 5, default: 0 },
} as const;

export const THEME_LOOK_FONT_STACK_MAX_LENGTH = 200;

/**
 * Family names only. No parentheses, colons, slashes, semicolons or braces, so a stack cannot
 * carry url(), @font-face or another declaration. Fonts are never loaded from the network.
 */
export const THEME_LOOK_FONT_STACK_PATTERN = /^[\p{L}\p{N} ,'"._-]+$/u;

export const ThemeLookFontStack = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THEME_LOOK_FONT_STACK_MAX_LENGTH),
  Schema.isPattern(THEME_LOOK_FONT_STACK_PATTERN),
);

const ranged = (limit: { readonly min: number; readonly max: number }) =>
  Schema.Int.check(Schema.isBetween({ minimum: limit.min, maximum: limit.max }));

export const ThemeLook = Schema.Struct({
  /** Interface font stack, tried before the app's own stack. */
  fontUi: Schema.optional(ThemeLookFontStack),
  /** Code and terminal font stack. */
  fontCode: Schema.optional(ThemeLookFontStack),
  radius: Schema.optional(ranged(THEME_LOOK_LIMITS.radius)),
  density: Schema.optional(ranged(THEME_LOOK_LIMITS.density)),
  shadow: Schema.optional(ranged(THEME_LOOK_LIMITS.shadow)),
  chatWidth: Schema.optional(ChatWidth),
  glass: Schema.optional(ranged(THEME_LOOK_LIMITS.glass)),
});
export type ThemeLook = typeof ThemeLook.Type;

export const THEME_LOOK_KEYS = [
  "fontUi",
  "fontCode",
  "radius",
  "density",
  "shadow",
  "chatWidth",
  "glass",
] as const satisfies ReadonlyArray<keyof ThemeLook>;
export type ThemeLookKey = (typeof THEME_LOOK_KEYS)[number];
