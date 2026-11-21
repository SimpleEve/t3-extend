import { isThemeLookFontStack } from "@t3tools/shared/forkThemeLook";

// fork: the studio's font rows pick one family from a list; a theme stores a font stack. These
// turn one into the other. A stack a preset brought (several families) shows its first family.

export type FontKind = "ui" | "code";

const GENERIC_FAMILY =
  /^(serif|sans-serif|monospace|system-ui|ui-monospace|ui-serif|ui-sans-serif|cursive|fantasy|emoji|math|fangsong)$/i;
// Names that are serif faces, so a missing one falls back to a serif rather than a sans.
const SERIF_FAMILY =
  /serif|georgia|times|palatino|garamond|baskerville|didot|bodoni|iowan|charter|cambria|constantia|song|ming|kai|mincho/i;

const unquote = (name: string) =>
  name
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();

/** The family a stack starts with, or "" for no stack. A stack of only generic names shows the first. */
export function familyOfStack(stack: string | undefined): string {
  if (stack === undefined) return "";
  const names = stack
    .split(",")
    .map(unquote)
    .filter((name) => name.length > 0);
  return names.find((name) => !GENERIC_FAMILY.test(name)) ?? names[0] ?? "";
}

/** The stack to store for a family, or undefined when it cannot be one a theme may carry. */
export function stackOfFamily(family: string, kind: FontKind): string | undefined {
  const name = family.trim().replaceAll('"', "");
  if (name === "") return undefined;
  const generic =
    kind === "code"
      ? "monospace"
      : SERIF_FAMILY.test(name) && !/sans/i.test(name)
        ? "serif"
        : "sans-serif";
  const stack = `"${name}", ${generic}`;
  return isThemeLookFontStack(stack) ? stack : undefined;
}

/** The value a row stores after the family `picked` is chosen; the current stack when it already starts there. */
export function nextStack(
  current: string | undefined,
  picked: string,
  kind: FontKind,
): { readonly change: boolean; readonly stack: string | undefined } {
  if (picked === "") return { change: current !== undefined, stack: undefined };
  if (familyOfStack(current) === picked) return { change: false, stack: current };
  const stack = stackOfFamily(picked, kind);
  return stack === undefined ? { change: false, stack: current } : { change: true, stack };
}

const CURATED_UI_FAMILIES: readonly string[] = [
  "PingFang SC",
  "Hiragino Sans GB",
  "Noto Sans SC",
  "Source Han Sans SC",
  "Microsoft YaHei",
  "Songti SC",
  "Kaiti SC",
  "Noto Serif SC",
  "Source Han Serif SC",
  "SF Pro",
  "Helvetica Neue",
  "Avenir Next",
  "Inter",
  "Segoe UI",
  "Seravek",
  "Gill Sans",
  "Trebuchet MS",
  "Verdana",
  "Georgia",
  "Iowan Old Style",
  "Palatino",
  "Times New Roman",
];

const CURATED_CODE_FAMILIES: readonly string[] = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Consolas",
  "Sarasa Mono SC",
  "Courier New",
];

/** The well-known families this device has, for when installed fonts cannot be listed. */
export function curatedFamilies(
  kind: FontKind,
  isInstalled: (family: string) => boolean,
): readonly string[] {
  return (kind === "code" ? CURATED_CODE_FAMILIES : CURATED_UI_FAMILIES).filter(isInstalled);
}
