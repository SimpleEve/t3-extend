import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

// fork: the fork's own mark replaces upstream's T3 glyph here; the wordmark beside it still reads
// "T3 Extend". Source of truth: assets/fork/mark.svg, rendered by scripts/fork-brand-icons.ts.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="T3" height={props.height} width={props.height} viewBox="26 26 76 76">
      <ThemedPath
        d="M34 34V94M34 34H94M34 64H78M34 94H62"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={16}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
