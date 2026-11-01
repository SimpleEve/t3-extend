# i18n

Zero-dependency interface translation for T3 Extend. English source strings are the keys, so
upstream copy changes fall back to English instead of breaking. Translation rules and terms are
in [GLOSSARY.md](./GLOSSARY.md) (Chinese); the fork workflow is in `FORK.md` under "多语言".

- `translate(locale, source, params?, context?)` is pure and has no DOM or React dependency, so the
  Electron main process uses it too.
- `setUiLocale` loads a locale's catalog with a dynamic `import()` before publishing the locale,
  so nothing renders half translated. English loads no catalog.
- `getUiLocale` / `subscribeUiLocale` are a `useSyncExternalStore`-shaped store. Each app wraps
  them in its own hook (web: `apps/web/src/hooks/useT.ts`), the same way `clock.ts` is consumed.

Never call `translate`, `t`, or `getUiLocale` at module top level. Modules load before saved
settings decide the language, so the result would stay English. Keep English in module constants
and translate when rendering, or call `translate(getUiLocale(), ...)` when the text is shown.
