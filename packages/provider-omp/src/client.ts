import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "omp",
  settingsSchema: OmpSettings,
  // oh-my-pi has no published mark, so this is a plain ring-and-dot glyph.
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z",
        fillRule: "evenodd",
      },
      { d: "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" },
    ],
  },
});
