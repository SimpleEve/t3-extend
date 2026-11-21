import { THEME_BACKGROUND_MAX_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkBackgroundFile, refusalOfStatus } from "./backgroundUpload.logic";

describe("checkBackgroundFile", () => {
  it.each([
    [{ type: "image/jpeg", size: 1 }, null],
    [{ type: "image/png", size: THEME_BACKGROUND_MAX_BYTES }, null],
    [{ type: "IMAGE/WEBP", size: 1024 }, null],
    // A file the system gave no type for is left to the server, which reads the bytes.
    [{ type: "", size: 1024 }, null],
    [{ type: "image/gif", size: 1024 }, "type"],
    [{ type: "image/svg+xml", size: 1024 }, "type"],
    [{ type: "application/pdf", size: 1024 }, "type"],
    [{ type: "image/png", size: THEME_BACKGROUND_MAX_BYTES + 1 }, "size"],
    [{ type: "image/png", size: 0 }, "size"],
  ])("%j -> %s", (file, expected) => {
    expect(checkBackgroundFile(file)).toBe(expected);
  });
});

describe("refusalOfStatus", () => {
  it.each([
    [415, "type"],
    [413, "size"],
    [507, "full"],
    [400, "failed"],
    [500, "failed"],
  ])("%d is %s", (status, reason) => {
    expect(refusalOfStatus(status)).toBe(reason);
  });
});
