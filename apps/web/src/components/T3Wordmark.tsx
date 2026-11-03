import type { SVGProps } from "react";

// fork: the fork's own mark replaces upstream's T3 glyph here; the wordmark beside it still reads
// "T3 Extend". Source of truth: assets/fork/mark.svg, rendered by scripts/fork-brand-icons.ts.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="26 26 76 76" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M34 34V94M34 34H94M34 64H78M34 94H62"
        fill="none"
        stroke="currentColor"
        strokeWidth={16}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
