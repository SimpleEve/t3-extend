import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectScriptMenuLabel } from "./projectScripts.ts";

const script = (flags: Partial<ProjectScript>) =>
  ({ id: "dev", name: "dev", command: "pnpm dev", icon: "play", ...flags }) as ProjectScript;

describe("projectScriptMenuLabel", () => {
  it("lists a script's roles after its name, in English without a translator", () => {
    expect(projectScriptMenuLabel(script({}))).toBe("dev");
    expect(projectScriptMenuLabel(script({ runOnWorktreeCreate: true, runOnSettle: true }))).toBe(
      "dev (setup, on settle)",
    );
  });

  it("translates the roles and the list joiner, and never the script's own name", () => {
    const t = (source: string, _params?: undefined, context?: string) =>
      `«${context === undefined ? "" : `${context}|`}${source}»`;
    expect(
      projectScriptMenuLabel(
        script({ name: "server", runOnWorktreeCreate: true, runOnSettle: true }),
        t,
      ),
    ).toBe("server («script role|setup»«, »«on settle»)");
  });
});
