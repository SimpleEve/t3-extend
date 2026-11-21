import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { useLoadedLocaleSelection, type LocaleSelection } from "./loadedLocaleSelection";

const EN = { catalogLocale: "en", formattingLocale: "en" } as const;
const ZH = { catalogLocale: "zh", formattingLocale: "zh-Hans-CN" } as const;
const FR = { catalogLocale: "fr", formattingLocale: "fr" } as const;

function setup() {
  const pending = new Map<string, PromiseWithResolvers<void>>();
  const load = (locale: string) => {
    const deferred = Promise.withResolvers<void>();
    pending.set(locale, deferred);
    return deferred.promise;
  };
  const seen: LocaleSelection[] = [];
  function Probe(props: { readonly target: LocaleSelection }) {
    seen.push(useLoadedLocaleSelection(props.target, load));
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (target: LocaleSelection) => act(() => root.render(<Probe target={target} />));
  return {
    pending,
    render,
    shown: () => seen.at(-1),
    settle: (locale: string, ok = true) =>
      act(async () => {
        const deferred = pending.get(locale)!;
        if (ok) deferred.resolve();
        else deferred.reject(new Error("load failed"));
        await deferred.promise.catch(() => undefined);
      }),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("useLoadedLocaleSelection", () => {
  // The upgraded phone: preferences load after the first frame, so English is shown, then zh is
  // wanted. zh must reach the screen once its catalog has loaded, with nothing else re-rendering.
  it("switches to the saved language once its catalog has loaded", async () => {
    using screen = setup();
    await screen.render(EN);
    await screen.settle("en");
    await screen.render(ZH);
    expect(screen.shown()).toEqual(EN);
    await screen.settle("zh");
    expect(screen.shown()).toEqual(ZH);
  });

  it("lets the latest choice win over a slower earlier one", async () => {
    using screen = setup();
    await screen.render(EN);
    await screen.render(ZH);
    await screen.render(FR);
    await screen.settle("fr");
    expect(screen.shown()).toEqual(FR);
    await screen.settle("zh");
    expect(screen.shown()).toEqual(FR);
  });

  it("still switches when the catalog fails to load", async () => {
    using screen = setup();
    await screen.render(EN);
    await screen.render(ZH);
    await screen.settle("zh", false);
    expect(screen.shown()).toEqual(ZH);
  });
});
