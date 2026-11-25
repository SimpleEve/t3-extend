import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { HexValueInput } from "./HexValueInput";

// Stands in for the studio, which expands a three or four digit hex the moment it is committed.
function Harness() {
  const [value, setValue] = useState("#fcfcfc");
  return (
    <HexValueInput
      committed={value}
      invalid={false}
      label="Background hex value"
      onCommit={(next) =>
        setValue(
          /^#[0-9a-f]{3,4}$/i.test(next)
            ? `#${next
                .slice(1)
                .split("")
                .map((c) => c + c)
                .join("")}`
            : next,
        )
      }
    />
  );
}

it("keeps the typed text while the hex is deleted through four digits", async () => {
  await using _screen = await render(<Harness />);
  const hex = page.getByRole("textbox", { name: "Background hex value" });
  await userEvent.click(hex);
  for (const expected of ["#fcfcf", "#fcfc", "#fcf", "#fc", "#f", "#"]) {
    await userEvent.keyboard("{Backspace}");
    await expect.element(hex).toHaveValue(expected);
  }
});
