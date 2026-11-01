import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.simpleeve.t3extend", "t3extend"],
  ["development", "com.simpleeve.t3extend.dev", "t3extend-dev"],
  ["preview", "com.simpleeve.t3extend.preview", "t3extend-preview"],
  ["production", "com.simpleeve.t3extend", "t3extend"],
])(
  "keeps the fork's identifiers and no official OTA source for APP_VARIANT=%j",
  async (value, identifier, scheme) => {
    const config = await loadConfig(value);
    expect(config.ios?.bundleIdentifier).toBe(identifier);
    expect(config.android?.package).toBe(identifier);
    expect(config.scheme).toBe(scheme);
    expect(config.updates).not.toHaveProperty("url");
    expect(config.updates?.enabled).toBe(false);
    expect(config.extra?.eas).not.toHaveProperty("projectId");
    expect(config).not.toHaveProperty("owner");
  },
);
