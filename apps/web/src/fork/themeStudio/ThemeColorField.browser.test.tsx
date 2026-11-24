import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThemeColorField } from "../../components/settings/ThemeColorPicker";

// Stands in for the guided palette, which rewrites the committed color as it changes.
function Harness() {
  const [value, setValue] = useState("#222222");
  return (
    <ThemeColorField
      role="canvas"
      label="Background"
      value={value}
      onChange={(_role, next) =>
        setValue(
          /^#[0-9a-f]{3}$/i.test(next)
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

it("keeps the typed text while the hex is backspaced past valid shorthand", async () => {
  await using _screen = await render(<Harness />);
  const hex = page.getByRole("textbox", { name: "Background hex value" });
  await userEvent.click(hex);

  for (const expected of ["#22222", "#2222", "#222", "#22", "#2", "#", ""]) {
    await userEvent.keyboard("{Backspace}");
    await expect.element(hex).toHaveValue(expected);
  }

  await userEvent.keyboard("#3366cc");
  await expect.element(hex).toHaveValue("#3366cc");
});
