// Guards the two deployment promises that are easy to break with a one-line compose edit.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const assert = NodeAssert;
const { it } = NodeTest;

const compose = NodeFS.readFileSync(
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "docker-compose.yml",
  ),
  "utf8",
);

/** service name -> its lines. A tiny reader for this one file: top-level keys under `services:` are indented two spaces. */
const services = new Map();
let current = null;
let inServices = false;
for (const line of compose.split("\n")) {
  if (/^services:/.test(line)) inServices = true;
  else if (/^\S/.test(line) && !line.startsWith("#")) inServices = false;
  const name = inServices ? /^ {2}([a-z0-9-]+):\s*$/.exec(line)?.[1] : undefined;
  if (name !== undefined) {
    current = [];
    services.set(name, current);
  } else if (inServices && current !== null) {
    current.push(line);
  }
}

it("reads the four services", () => {
  assert.deepEqual([...services.keys()].toSorted(), ["caddy", "frps", "ntfy", "registry"]);
});

it("pins every downloaded image to a version and a digest", () => {
  for (const [name, lines] of services) {
    const image = lines.map((l) => /^ {4}image:\s*(\S+)/.exec(l)?.[1]).find(Boolean);
    if (name === "registry") continue; // built from ./registry, whose Dockerfile pins its base image
    assert.match(image, /:v?[0-9][^@\s]*@sha256:[0-9a-f]{64}$/, `${name} image is ${image}`);
  }
  const dockerfile = NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /^FROM \S+:24\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}$/m);
});

it("publishes ports from Caddy only", () => {
  for (const [name, lines] of services) {
    const publishes = lines.some((l) => /^ {4}ports:/.test(l));
    assert.equal(
      publishes,
      name === "caddy",
      `${name} ${publishes ? "publishes" : "does not publish"} ports`,
    );
  }
});
