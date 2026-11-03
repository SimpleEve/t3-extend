import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveFooterScope, sameScopedProjectRefs } from "./footerScope.logic";

const ref = (environment: string, project: string) => ({
  environmentId: environment as EnvironmentId,
  projectId: project as ProjectId,
});
const primary = "primary" as EnvironmentId;

describe("footer scope", () => {
  it("prefers the chosen project, then the open thread, then the primary environment", () => {
    expect(
      resolveFooterScope({
        scopedProjectRefs: [ref("a", "p1"), ref("a", "p2")],
        routeProjectRef: ref("b", "p3"),
        primaryEnvironmentId: primary,
      }),
    ).toMatchObject({ environmentId: "a", source: "scope" });
    expect(
      resolveFooterScope({
        scopedProjectRefs: [],
        routeProjectRef: ref("b", "p3"),
        primaryEnvironmentId: primary,
      }),
    ).toMatchObject({ environmentId: "b", source: "route" });
    expect(
      resolveFooterScope({
        scopedProjectRefs: [],
        routeProjectRef: null,
        primaryEnvironmentId: primary,
      }),
    ).toMatchObject({ environmentId: primary, source: "primary", projectRefs: [] });
    expect(
      resolveFooterScope({
        scopedProjectRefs: [],
        routeProjectRef: null,
        primaryEnvironmentId: null,
      }),
    ).toMatchObject({ environmentId: null, source: "none" });
  });

  it("does not pick a machine for a project choice that spans environments", () => {
    expect(
      resolveFooterScope({
        scopedProjectRefs: [ref("a", "p1"), ref("b", "p2")],
        routeProjectRef: null,
        primaryEnvironmentId: primary,
      }),
    ).toMatchObject({ environmentId: primary, source: "primary" });
  });

  it("compares project refs by content", () => {
    expect(sameScopedProjectRefs([ref("a", "p")], [ref("a", "p")])).toBe(true);
    expect(sameScopedProjectRefs([ref("a", "p")], [ref("a", "q")])).toBe(false);
  });
});
