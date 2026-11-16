import { describe, expect, it } from "@effect/vitest";

import { parseOmpModels } from "./status.ts";

// Trimmed from `get_state` and `get_available_models` of omp 18.20.2.
const state = {
  model: { provider: "magpie", id: "auto/deepseek-v4.1-flash" },
  thinkingLevel: "high",
};
const models = {
  models: [
    {
      id: "auto/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash · routing group",
      provider: "magpie",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high", "max"] },
    },
    { id: "plain", name: "Plain", provider: "magpie", reasoning: false },
    { id: "codex/gpt-image-2", provider: "magpie", kind: "image" },
    { id: "auto/deepseek-v4.1-flash", name: "Duplicate", provider: "magpie" },
  ],
};

describe("omp model discovery", () => {
  it("lists chat models by provider/id and reports each reasoning model's efforts", () => {
    const parsed = parseOmpModels(models, state);
    expect(parsed?.map((model) => model.slug)).toEqual([
      "magpie/auto/deepseek-v4.1-flash",
      "magpie/plain",
    ]);
    expect(parsed?.[0]).toMatchObject({
      name: "DeepSeek V4.1 Flash · routing group",
      subProvider: "magpie",
    });
    const thinking = parsed?.[0]?.capabilities?.optionDescriptors?.[0];
    expect(thinking).toMatchObject({ id: "thinking", type: "select" });
    expect((thinking as { options: Array<{ id: string; isDefault?: boolean }> }).options).toEqual([
      { id: "off", label: "Off" },
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
      { id: "max", label: "Max" },
    ]);
    expect(parsed?.[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("returns undefined for an unreadable catalog", () => {
    expect(parseOmpModels({ models: "none" }, state)).toBeUndefined();
    expect(parseOmpModels(undefined, state)).toBeUndefined();
  });
});
