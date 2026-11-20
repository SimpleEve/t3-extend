import { describe, expect, it } from "vite-plus/test";

import { isLoopbackLink, linkChoices, linkChoicesTapFirst, linkTapChoice } from "./linkChoices";

describe("isLoopbackLink", () => {
  it.each([
    "http://localhost:4391/outputs/index.html",
    "https://LOCALHOST/",
    "http://app.localhost:3000/",
    "http://127.0.0.1:5173/",
    "http://127.8.9.10/",
    "http://[::1]:8080/path",
    "http://0.0.0.0:3000",
    "  http://localhost:3000/x?y=1#z ",
    "http://user:pass@localhost:3000/",
  ])("treats %s as loopback", (href) => {
    expect(isLoopbackLink(href)).toBe(true);
  });

  it.each([
    "https://example.com/localhost",
    "https://localhost.example.com/",
    "http://128.0.0.1/",
    "http://192.168.1.5:3000/",
    "http://[2001:db8::1]/",
    "https://example.com/?next=http://localhost:3000",
    "ftp://localhost/",
    "mailto:a@localhost",
    "/relative/localhost",
    "localhost:3000",
    "",
  ])("does not treat %s as loopback", (href) => {
    expect(isLoopbackLink(href)).toBe(false);
  });
});

describe("a link's choices", () => {
  const loopback = "http://localhost:4391/a";
  const remote = "https://example.com/a";

  it("taps a loopback link into the built-in browser when it is available", () => {
    expect(linkTapChoice(loopback, true)).toBe("built-in");
  });

  it.each([
    ["a loopback link the built-in browser cannot open", loopback, false],
    ["a remote link", remote, true],
    ["a remote link without the built-in browser", remote, false],
    ["a link that is not a web link", "mailto:a@b.com", true],
  ])("taps %s into the system browser", (_name, href, available) => {
    expect(linkTapChoice(href, available)).toBe("system");
  });

  it("offers the built-in browser only for web links when it is available", () => {
    expect(linkChoices(remote, true)).toEqual(["built-in", "system", "copy"]);
    expect(linkChoices(loopback, false)).toEqual(["system", "copy"]);
    expect(linkChoices("mailto:a@b.com", true)).toEqual(["system", "copy"]);
  });

  it("lists the tap's choice first", () => {
    expect(linkChoicesTapFirst(loopback, true)).toEqual(["built-in", "system", "copy"]);
    expect(linkChoicesTapFirst(remote, true)).toEqual(["system", "built-in", "copy"]);
    expect(linkChoicesTapFirst(remote, false)).toEqual(["system", "copy"]);
  });
});
