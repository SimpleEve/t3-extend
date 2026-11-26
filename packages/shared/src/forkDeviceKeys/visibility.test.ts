// The visibility rules, and a check that the registry (plain Node, written separately) decides the same.
import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_VISIBILITY,
  isVisibleTo,
  normalizeVisibility,
  sameVisibility,
  type Visibility,
  type VisibilityMode,
} from "./visibility.ts";

interface RegistryDb {
  isVisibleTo: (
    owner: { id: string; kind: string; visibility: Visibility },
    viewerId: string,
  ) => boolean;
  normalizeVisibility: (mode: VisibilityMode, deviceIds: ReadonlyArray<string>) => Visibility;
}

const load = async (): Promise<RegistryDb> =>
  (await import(
    /* @vite-ignore */ new URL("../../../../infra/self-host/registry/db.mjs", import.meta.url).href
  )) as RegistryDb;

const MODES: ReadonlyArray<VisibilityMode> = [
  "visible_to_all",
  "hidden_from_all",
  "hidden_from_selected",
  "visible_to_selected",
];

describe("visibility", () => {
  it("applies each mode to a viewer", () => {
    const only = (mode: VisibilityMode) => ({ mode, deviceIds: ["a"] });
    assert.isTrue(isVisibleTo(DEFAULT_VISIBILITY, "a"));
    assert.isFalse(isVisibleTo({ mode: "hidden_from_all", deviceIds: [] }, "a"));
    assert.isFalse(isVisibleTo(only("hidden_from_selected"), "a"));
    assert.isTrue(isVisibleTo(only("hidden_from_selected"), "b"));
    assert.isTrue(isVisibleTo(only("visible_to_selected"), "a"));
    assert.isFalse(isVisibleTo(only("visible_to_selected"), "b"));
  });

  it("canonicalises: sorted, unique, and empty for the modes that name no devices", () => {
    assert.deepEqual(
      normalizeVisibility({ mode: "hidden_from_selected", deviceIds: ["b", "a", "b"] }),
      {
        mode: "hidden_from_selected",
        deviceIds: ["a", "b"],
      },
    );
    assert.deepEqual(normalizeVisibility({ mode: "hidden_from_all", deviceIds: ["a"] }), {
      mode: "hidden_from_all",
      deviceIds: [],
    });
    assert.isTrue(
      sameVisibility(
        { mode: "visible_to_selected", deviceIds: ["b", "a"] },
        { mode: "visible_to_selected", deviceIds: ["a", "b", "a"] },
      ),
    );
    assert.isFalse(
      sameVisibility(
        { mode: "visible_to_selected", deviceIds: ["a"] },
        { mode: "hidden_from_selected", deviceIds: ["a"] },
      ),
    );
  });

  it("decides exactly as the registry does, for every mode and viewer", async () => {
    const registry = await load();
    for (const mode of MODES) {
      for (const deviceIds of [[], ["a"], ["a", "b"], ["b", "a", "a"]]) {
        const visibility = { mode, deviceIds } satisfies Visibility;
        assert.deepEqual(
          registry.normalizeVisibility(mode, deviceIds),
          normalizeVisibility(visibility),
        );
        for (const viewer of ["a", "b", "c"]) {
          assert.equal(
            registry.isVisibleTo(
              { id: "owner", kind: "computer", visibility: normalizeVisibility(visibility) },
              viewer,
            ),
            isVisibleTo(visibility, viewer),
            `${mode} ${JSON.stringify(deviceIds)} ${viewer}`,
          );
        }
      }
    }
  });
});
