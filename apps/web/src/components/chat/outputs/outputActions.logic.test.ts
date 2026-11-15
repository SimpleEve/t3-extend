import { describe, expect, it } from "vite-plus/test";

import {
  isUsersOwnMachine,
  outputFileActionIds,
  outputLinkActionIds,
  primaryOutputAction,
} from "./outputActions.logic";

describe("isUsersOwnMachine", () => {
  it.each([
    ["the desktop app's own server", true, "env-1", "env-1", true],
    ["a remote server seen from the desktop app", true, "env-2", "env-1", false],
    ["a browser, even on the host's environment", false, "env-1", "env-1", false],
    ["no host environment known yet", true, "env-1", null, false],
    ["no environment", true, null, "env-1", false],
  ])("%s", (_name, isElectron, environmentId, hostEnvironmentId, expected) => {
    expect(isUsersOwnMachine({ isElectron, environmentId, hostEnvironmentId })).toBe(expected);
  });
});

describe("outputFileActionIds", () => {
  it.each([
    [
      "in the workspace, on the user's machine",
      true,
      true,
      true,
      true,
      ["preview", "open", "reveal", "copy"],
    ],
    ["in the workspace, no reveal support", true, true, true, false, ["preview", "open", "copy"]],
    [
      "outside the workspace, on the user's machine",
      false,
      true,
      true,
      true,
      ["open", "reveal", "copy"],
    ],
    ["in the workspace, remote or browser", true, false, true, true, ["preview", "copy"]],
    ["outside the workspace, remote or browser", false, false, true, true, ["copy"]],
    ["no file manager on the server", true, true, false, true, ["preview", "copy"]],
  ])("%s", (_name, inWorkspace, onThisMachine, hasFileManager, canReveal, expected) => {
    expect(outputFileActionIds({ inWorkspace, onThisMachine, hasFileManager, canReveal })).toEqual(
      expected,
    );
  });
});

describe("outputLinkActionIds", () => {
  it.each([
    ["with the browser panel", true, ["preview", "external", "copy"]],
    ["without the browser panel", false, ["external", "copy"]],
  ])("%s", (_name, canPreviewLinks, expected) => {
    expect(outputLinkActionIds({ canPreviewLinks })).toEqual(expected);
  });
});

describe("primaryOutputAction", () => {
  it.each([
    ["preview first", ["preview", "open", "copy"], "preview"],
    ["open when there is no preview", ["open", "reveal", "copy"], "open"],
    ["nothing when only copy is left", ["copy"], null],
  ])("%s", (_name, ids, expected) => {
    expect(primaryOutputAction(ids)).toBe(expected);
  });
});
