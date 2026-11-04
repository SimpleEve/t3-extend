// @effect-diagnostics nodeBuiltinImport:off - the work directory the stack writes its files into.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { describeDownProblem, prepareStack, type RunDocker } from "./stack.ts";
import type { RunResult } from "./util.ts";

let workDir: string;
beforeEach(async () => {
  workDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3x-stack-test-"));
});
afterEach(async () => {
  await NodeFSP.rm(workDir, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const verbOf = (args: ReadonlyArray<string>) =>
  ["ps", "up", "down", "exec"].find((verb) => args.includes(verb));

describe("describeDownProblem", () => {
  it("is silent on success and otherwise names the project, the error and the manual command", () => {
    expect(describeDownProblem("t3x-e2e", ok())).toBeUndefined();
    const problem = describeDownProblem("t3x-e2e", {
      status: 1,
      stdout: "",
      stderr: "network t3x-e2e_default has active endpoints",
    });
    expect(problem).toContain("t3x-e2e");
    expect(problem).toContain("active endpoints");
    expect(problem).toContain("docker compose -p t3x-e2e down -v --remove-orphans");
  });
});

describe("prepareStack", () => {
  it("refuses a project name that already has containers, and never runs down on it", async () => {
    const verbs: Array<string | undefined> = [];
    const docker: RunDocker = async (args) => {
      verbs.push(verbOf(args));
      return ok("someone-elses-container\n");
    };
    await expect(
      prepareStack({ project: "taken", port: 18_999, workDir, say: () => {}, docker }),
    ).rejects.toThrow(/already has containers/u);
    expect(verbs).toEqual(["ps"]);
  });

  it("does not take an empty answer for an empty project when docker itself failed", async () => {
    for (const status of [1, null]) {
      const verbs: Array<string | undefined> = [];
      const docker: RunDocker = async (args) => {
        verbs.push(verbOf(args));
        return { status, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      };
      await expect(
        prepareStack({ project: "p", port: 18_999, workDir, say: () => {}, docker }),
      ).rejects.toThrow(/Cannot connect to the Docker daemon/u);
      // Nothing was confirmed, so no stack comes back to be cleaned up and down never runs.
      expect(verbs).toEqual(["ps"]);
    }
  });

  it("stops an up that is still running before it removes the project, and can be called again", async () => {
    const events: Array<string> = [];
    const docker: RunDocker = (args, options) => {
      const verb = verbOf(args);
      if (verb === "up") {
        events.push("up started");
        return new Promise((resolve) =>
          options?.signal?.addEventListener("abort", () => {
            events.push("up aborted");
            resolve({ status: null, stdout: "", stderr: "" });
          }),
        );
      }
      events.push(verb ?? "other");
      return Promise.resolve(ok());
    };
    const stack = await prepareStack({
      project: "p",
      port: 18_999,
      workDir,
      say: () => {},
      docker,
    });

    const up = stack.up();
    const upOutcome = up.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(await stack.down()).toBeUndefined();
    expect(await upOutcome).toMatch(/docker compose up failed/u);
    expect(events).toEqual(["ps", "up started", "up aborted", "down"]);

    expect(await stack.down()).toBeUndefined();
    expect(events.at(-1)).toBe("down");
  });

  it("reports a down that docker refused", async () => {
    const docker: RunDocker = async (args) =>
      verbOf(args) === "down" ? { status: 1, stdout: "", stderr: "denied" } : ok();
    const stack = await prepareStack({
      project: "p",
      port: 18_999,
      workDir,
      say: () => {},
      docker,
    });
    expect(await stack.down()).toContain("docker compose -p p down -v --remove-orphans");
  });
});
