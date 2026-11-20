import type { UiLocale } from "./locale.ts";

export type Catalog = Readonly<Record<string, string>>;
export type TranslateParams = Readonly<Record<string, string | number>>;

/** Separates a disambiguating context from the English source in a catalog key: `"sidebar section|Active"`. */
export const CONTEXT_SEPARATOR = "|";

/** Catalog key for an English source that needs a different translation in one context. */
function contextKey(context: string, source: string): string {
  return `${context}${CONTEXT_SEPARATOR}${source}`;
}

// Literal `import()` calls so bundlers split each catalog into its own chunk.
const catalogLoaders: Readonly<Record<Exclude<UiLocale, "en">, () => Promise<Catalog>>> = {
  "zh-Hans": () => import("./catalogs/zh-Hans/index.ts").then((module) => module.default),
};

const loadedCatalogs = new Map<UiLocale, Catalog>();
const pendingCatalogs = new Map<UiLocale, Promise<Catalog | null>>();

/**
 * Loads a locale's catalog once. Resolves `null` for English, which has none,
 * and when the load fails. The next call imports again, but browsers cache the
 * failed module, so it fails again until the page reloads.
 */
export function loadUiCatalog(locale: UiLocale): Promise<Catalog | null> {
  if (locale === "en") return Promise.resolve(null);
  const loaded = loadedCatalogs.get(locale);
  if (loaded) return Promise.resolve(loaded);
  const pending = pendingCatalogs.get(locale);
  if (pending) return pending;
  const next = catalogLoaders[locale]()
    .then((catalog) => {
      loadedCatalogs.set(locale, catalog);
      return catalog;
    })
    .catch(() => null)
    .finally(() => pendingCatalogs.delete(locale));
  pendingCatalogs.set(locale, next);
  return next;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/** Placeholder names in a source or translation, used to keep the two in step. */
export function placeholderNames(template: string): ReadonlyArray<string> {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]!))].sort();
}

/**
 * Translates an English source string. Missing translations, and locales whose
 * catalog has not loaded, return the source, so new upstream copy shows in English.
 */
export function translate(
  locale: UiLocale,
  source: string,
  params?: TranslateParams,
  context?: string,
): string {
  const catalog = locale === "en" ? undefined : loadedCatalogs.get(locale);
  const translated =
    catalog === undefined
      ? undefined
      : ((context === undefined ? undefined : catalog[contextKey(context, source)]) ??
        catalog[source]);
  return interpolate(translated ?? source, params);
}

export function __setUiCatalogForTests(locale: UiLocale, catalog: Catalog | null): void {
  if (catalog === null) loadedCatalogs.delete(locale);
  else loadedCatalogs.set(locale, catalog);
}
