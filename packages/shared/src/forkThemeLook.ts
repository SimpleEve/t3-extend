import {
  THEME_LOOK_FONT_STACK_MAX_LENGTH,
  THEME_LOOK_FONT_STACK_PATTERN,
  THEME_LOOK_KEYS,
  THEME_LOOK_LIMITS,
  type ThemeLook,
  type ThemeLookKey,
} from "@t3tools/contracts";

// fork: parsing and CSS for a theme's look. The limits live in contracts so the server schema,
// the theme file importer and the sliders agree on one set of numbers.

const CHAT_WIDTHS: ReadonlySet<string> = new Set(["comfortable", "wide", "full"]);
const NUMERIC_KEYS = ["radius", "density", "shadow", "glass"] as const;
type NumericLookKey = (typeof NUMERIC_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThemeLookFontStack(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= THEME_LOOK_FONT_STACK_MAX_LENGTH &&
    THEME_LOOK_FONT_STACK_PATTERN.test(value)
  );
}

function numberInRange(key: NumericLookKey, value: unknown): value is number {
  const { min, max } = THEME_LOOK_LIMITS[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function clampThemeLookNumber(key: NumericLookKey, value: number): number {
  const { min, max } = THEME_LOOK_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * For files a person or an agent wrote: every problem is an error, because a typo that is
 * silently dropped looks like a theme that does nothing.
 */
export function parseThemeLook(value: unknown): ThemeLook | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("A theme look must be an object.");
  const look: Partial<Record<ThemeLookKey, string | number>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (!(THEME_LOOK_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new Error(`"${key}" is not a supported look setting.`);
    }
    if (key === "fontUi" || key === "fontCode") {
      if (!isThemeLookFontStack(entry)) {
        throw new Error(
          `The look ${key} must be font family names separated by commas, up to ${THEME_LOOK_FONT_STACK_MAX_LENGTH} characters.`,
        );
      }
      look[key] = entry;
    } else if (key === "chatWidth") {
      if (typeof entry !== "string" || !CHAT_WIDTHS.has(entry)) {
        throw new Error('The look chatWidth must be "comfortable", "wide" or "full".');
      }
      look[key] = entry;
    } else {
      const numericKey = key as NumericLookKey;
      if (!numberInRange(numericKey, entry)) {
        const { min, max } = THEME_LOOK_LIMITS[numericKey];
        throw new Error(`The look ${key} must be a whole number from ${min} to ${max}.`);
      }
      look[numericKey] = entry;
    }
  }
  return Object.keys(look).length > 0 ? (look as ThemeLook) : undefined;
}

/** For data that is already stored or published: keep what is valid, clamp numbers, drop the rest. */
export function sanitizeThemeLook(value: unknown): ThemeLook | undefined {
  if (!isRecord(value)) return undefined;
  const look: { -readonly [K in ThemeLookKey]?: ThemeLook[K] } = {};
  if (isThemeLookFontStack(value.fontUi)) look.fontUi = value.fontUi;
  if (isThemeLookFontStack(value.fontCode)) look.fontCode = value.fontCode;
  if (typeof value.chatWidth === "string" && CHAT_WIDTHS.has(value.chatWidth)) {
    look.chatWidth = value.chatWidth as ThemeLook["chatWidth"];
  }
  for (const key of NUMERIC_KEYS) {
    const entry = value[key];
    if (typeof entry === "number" && Number.isFinite(entry)) {
      look[key] = clampThemeLookNumber(key, entry);
    }
  }
  return Object.keys(look).length > 0 ? look : undefined;
}

export function themeLooksEqual(a: ThemeLook | undefined, b: ThemeLook | undefined): boolean {
  return THEME_LOOK_KEYS.every((key) => a?.[key] === b?.[key]);
}

/** Sets or clears one setting, and returns undefined when nothing is left. */
export function withThemeLookValue<K extends ThemeLookKey>(
  look: ThemeLook | undefined,
  key: K,
  value: ThemeLook[K] | undefined,
): ThemeLook | undefined {
  const next: { -readonly [P in ThemeLookKey]?: ThemeLook[P] } = { ...look };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

const THEME_LOOK_SHADOW_VARIABLES = [
  "--shadow-2xs",
  "--shadow-xs",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-xl",
  "--shadow-2xl",
] as const;

/** Tailwind's stock shadows, as [offsets, alpha] layers, so strength scales only the alpha. */
const STOCK_SHADOWS: Readonly<Record<(typeof THEME_LOOK_SHADOW_VARIABLES)[number], string>> = {
  "--shadow-2xs": "0 1px|0.05",
  "--shadow-xs": "0 1px 2px 0|0.05",
  "--shadow-sm": "0 1px 3px 0|0.1;0 1px 2px -1px|0.1",
  "--shadow-md": "0 4px 6px -1px|0.1;0 2px 4px -2px|0.1",
  "--shadow-lg": "0 10px 15px -3px|0.1;0 4px 6px -4px|0.1",
  "--shadow-xl": "0 20px 25px -5px|0.1;0 8px 10px -6px|0.1",
  "--shadow-2xl": "0 25px 50px -12px|0.25",
};

function themeLookShadowValue(
  variable: (typeof THEME_LOOK_SHADOW_VARIABLES)[number],
  strength: number,
): string {
  const scale = clampThemeLookNumber("shadow", strength) / 100;
  return STOCK_SHADOWS[variable]
    .split(";")
    .map((layer) => {
      const [offsets, alpha] = layer.split("|") as [string, string];
      return `${offsets} rgb(0 0 0 / ${Math.min(1, Number(alpha) * scale).toFixed(3)})`;
    })
    .join(", ");
}

/** Every variable a look can set on the document root besides fonts, so applying one can clear the rest. */
export const THEME_LOOK_VARIABLES = [
  "--radius",
  "--radius-grow",
  "--control-radius",
  "--spacing",
  "--theme-panel-alpha",
  "--theme-panel-blur",
  ...THEME_LOOK_SHADOW_VARIABLES,
] as const;

/** A null value means the variable must be removed so the app's own value shows. */
export function themeLookCssVariables(
  look: ThemeLook | undefined,
): Readonly<Record<(typeof THEME_LOOK_VARIABLES)[number], string | null>> {
  const glass = look?.glass;
  return {
    "--radius": look?.radius === undefined ? null : `${look.radius / 16}rem`,
    // 1 from the stock radius up and shrinking to 0 below it, so the sizes around --radius close
    // up with it and a radius of 0 leaves no rounded tier. index.css reads it with a fallback of 1.
    // Inputs, badges and sidebar rows use their own constant, so the radius has to reach it too.
    "--control-radius": look?.radius === undefined ? null : `${look.radius / 16}rem`,
    "--radius-grow":
      look?.radius === undefined
        ? null
        : String(Math.min(1, look.radius / THEME_LOOK_LIMITS.radius.default)),
    "--spacing": look?.density === undefined ? null : `${(0.25 * look.density) / 100}rem`,
    "--theme-panel-alpha": glass === undefined || glass === 0 ? null : `${100 - glass}%`,
    "--theme-panel-blur": glass === undefined || glass === 0 ? null : `${Math.round(glass / 4)}px`,
    ...Object.fromEntries(
      THEME_LOOK_SHADOW_VARIABLES.map((variable) => [
        variable,
        look?.shadow === undefined ? null : themeLookShadowValue(variable, look.shadow),
      ]),
    ),
  } as Record<(typeof THEME_LOOK_VARIABLES)[number], string | null>;
}
