import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  accountRefreshFailed,
  accountRefreshRequest,
  permittedRefreshEnvironmentsAtom,
  permittedRefreshTargets,
  refreshEnvironmentsKey,
} from "./refresh.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const here = EnvironmentId.make("here");
const there = EnvironmentId.make("there");
const gone = EnvironmentId.make("gone");

describe("refreshing Antigravity accounts", () => {
  it("names one account or, without one, the whole instance", () => {
    expect(
      accountRefreshRequest({ environmentId: here, instanceId, accountId: "aaaaaaaaaaaaaaaa" }),
    ).toEqual({ environmentId: here, input: { instanceId, methodId: "aaaaaaaaaaaaaaaa" } });
    expect(accountRefreshRequest({ environmentId: here, instanceId })).toEqual({
      environmentId: here,
      input: { instanceId },
    });
  });

  it("counts a request that did not succeed as failed, unless it was interrupted", () => {
    expect(accountRefreshFailed(undefined)).toBe(true);
    expect(accountRefreshFailed({ _tag: "Success" } as never)).toBe(false);
  });

  // fork: refresh-all asks each environment's own grant instead of the first one's.
  it("lists the environments that may refresh, one by one", () => {
    const grants = new Map([
      [here, true],
      [there, false],
      [gone, true],
    ]);
    const atoms = permittedRefreshEnvironmentsAtom((id) => Atom.make(grants.get(id) ?? false));
    const targets = [
      { environmentId: here, instanceId },
      { environmentId: there, instanceId },
      { environmentId: here, instanceId: ProviderInstanceId.make("other") },
    ];
    const key = refreshEnvironmentsKey(targets);
    // The same environment twice is asked once, in a stable order.
    expect(key).toBe(JSON.stringify([here, there].sort()));
    const registry = AtomRegistry.make();
    const permitted = registry.get(atoms(key));
    expect(JSON.parse(permitted)).toEqual([here]);
    expect(permittedRefreshTargets(targets, permitted)).toEqual([targets[0], targets[2]]);
    expect(permittedRefreshTargets(targets, JSON.stringify([]))).toEqual([]);
  });
});
