import { useState } from "react";

import { isShortHexColor } from "../../components/settings/ThemeColorPicker";
import { Input } from "../../components/ui/input";

/**
 * A color's hex field. While it has focus it shows what was typed, not the committed color, since
 * the guided palette rewrites the committed one. A three or four digit hex is usually a longer one
 * being deleted, so it is committed on blur instead of expanding under the cursor.
 */
export function HexValueInput({
  committed,
  invalid,
  label,
  onCommit,
}: {
  readonly committed: string;
  readonly invalid: boolean;
  readonly label: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      aria-invalid={invalid}
      aria-label={label}
      font="mono"
      nativeInput
      onBlur={() => {
        if (draft !== null && isShortHexColor(draft)) onCommit(draft);
        setDraft(null);
      }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setDraft(next);
        if (!isShortHexColor(next)) onCommit(next);
      }}
      onFocus={() => setDraft(committed)}
      size="compact"
      value={draft ?? committed}
    />
  );
}
