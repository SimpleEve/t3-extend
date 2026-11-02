// fork: a provider badge is a fixed 12-14px circle, so initials that start with a Han character
// show that one grapheme, sized to fit; everything else keeps upstream's initials unchanged.
// The web app's floor is Tailwind v4's (Safari 16.4, Chrome 111, Firefox 128), all of which ship
// Intl.Segmenter, so the fallback only guards unsupported browsers.
const graphemes =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function firstGrapheme(text: string): string {
  if (graphemes === null) return Array.from(text)[0] ?? "";
  for (const { segment } of graphemes.segment(text)) return segment;
  return "";
}

export function resolveBadgeInitials(initials: string): {
  readonly text: string;
  readonly han: boolean;
} {
  const first = firstGrapheme(initials);
  return /^\p{Script_Extensions=Han}/u.test(first)
    ? { text: first, han: true }
    : { text: initials, han: false };
}
