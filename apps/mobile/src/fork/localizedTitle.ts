// fork: i18n. Native stack options are read each time the navigator renders, so a route's
// `title` is a getter: a plain string would keep the language the module was loaded in.
import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";

export function withLocalizedTitle<T extends { readonly title?: unknown }>(options: T): T {
  const source = options.title;
  if (typeof source !== "string") return options;
  return Object.defineProperty({ ...options }, "title", {
    enumerable: true,
    get: () => translate(getUiLocale(), source),
  });
}
