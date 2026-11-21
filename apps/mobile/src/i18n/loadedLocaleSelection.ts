// fork: switch GT's locale only once its catalog has loaded. Upstream deferred the switch with
// useDeferredValue and let GT suspend on the catalog; on Android release builds that deferred
// render was never retried when the zh catalog finished loading, so the app stayed in the previous
// language (English after an upgrade) until something else re-rendered it.
import { useEffect, useState } from "react";

export interface LocaleSelection {
  readonly catalogLocale: string;
  readonly formattingLocale: string;
}

/** The selection to render: `target` once `load` has finished for its catalog, the last one until then. */
export function useLoadedLocaleSelection(
  target: LocaleSelection,
  load: (locale: string) => Promise<unknown>,
): LocaleSelection {
  const [shown, setShown] = useState(target);
  const { catalogLocale, formattingLocale } = target;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for GT's catalog load, an async source outside React
  useEffect(() => {
    let current = true;
    const show = () => {
      if (current) setShown({ catalogLocale, formattingLocale });
    };
    // A failed load still switches: GT then falls back to the source text, as it would anyway.
    void load(catalogLocale).then(show, show);
    return () => {
      current = false;
    };
  }, [catalogLocale, formattingLocale, load]);
  return shown;
}
