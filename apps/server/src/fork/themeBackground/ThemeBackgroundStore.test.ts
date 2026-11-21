// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { THEME_BACKGROUND_MAX_BYTES } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  MAX_STORED_THEME_BACKGROUNDS,
  findStoredThemeBackground,
  sniffThemeBackground,
  storeThemeBackground,
  themeBackgroundDirectory,
} from "./ThemeBackgroundStore.ts";
import {
  THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX,
  issueThemeBackgroundUploadUrl,
  storeThemeBackgroundUpload,
  validateThemeBackgroundUploadToken,
} from "./upload.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("pixels"),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("pixels")]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([1, 0, 0, 0]),
  Buffer.from("WEBPVP8 pixels"),
]);

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const makeThemesDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-theme-bg-"));

describe("sniffThemeBackground", () => {
  it.each([
    ["jpg", JPEG, "image/jpeg"],
    ["png", PNG, "image/png"],
    ["webp", WEBP, "image/webp"],
  ])("reads %s from its bytes", (extension, bytes, mimeType) => {
    expect(sniffThemeBackground(bytes)).toEqual({ extension, mimeType });
  });

  // The name and declared type of an upload are never consulted, so only bytes can lie.
  it.each([
    ["GIF", Buffer.from("GIF89a....")],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["HTML", Buffer.from("<!doctype html><script>alert(1)</script>")],
    [
      "RIFF that is not WebP",
      Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]),
    ],
    ["a truncated PNG signature", PNG.subarray(0, 4)],
    ["nothing", Buffer.alloc(0)],
  ])("refuses %s", (_label, bytes) => {
    expect(sniffThemeBackground(bytes)).toBeNull();
  });
});

describe("storeThemeBackground", () => {
  it("names the file by the hash of its bytes and stores the same picture once", () => {
    const themesDir = makeThemesDir();
    const first = storeThemeBackground(themesDir, PNG);
    expect(first).toEqual({ ok: true, hash: sha256(PNG) });
    const stored = findStoredThemeBackground(themesDir, sha256(PNG));
    expect(stored).toEqual({
      path: NodePath.join(themeBackgroundDirectory(themesDir), `${sha256(PNG)}.png`),
      mimeType: "image/png",
    });
    expect(NodeFS.readFileSync(stored!.path)).toEqual(PNG);
    expect(storeThemeBackground(themesDir, PNG)).toEqual(first);
    expect(NodeFS.readdirSync(themeBackgroundDirectory(themesDir))).toEqual([`${sha256(PNG)}.png`]);
  });

  it("keeps pictures apart by their bytes and finds each by its own type", () => {
    const themesDir = makeThemesDir();
    storeThemeBackground(themesDir, JPEG);
    storeThemeBackground(themesDir, WEBP);
    expect(findStoredThemeBackground(themesDir, sha256(JPEG))?.mimeType).toBe("image/jpeg");
    expect(findStoredThemeBackground(themesDir, sha256(WEBP))?.mimeType).toBe("image/webp");
    expect(findStoredThemeBackground(themesDir, sha256(PNG))).toBeNull();
  });

  it("refuses what is not an image and what is too large, and writes nothing", () => {
    const themesDir = makeThemesDir();
    expect(storeThemeBackground(themesDir, Buffer.from("not an image"))).toMatchObject({
      ok: false,
      status: 415,
    });
    expect(storeThemeBackground(themesDir, Buffer.alloc(0))).toMatchObject({
      ok: false,
      status: 413,
    });
    const huge = Buffer.concat([PNG, Buffer.alloc(THEME_BACKGROUND_MAX_BYTES)]);
    expect(storeThemeBackground(themesDir, huge)).toMatchObject({ ok: false, status: 413 });
    expect(NodeFS.existsSync(themeBackgroundDirectory(themesDir))).toBe(false);
  });

  it("only looks up a name that is a hash, so a path never leaves the directory", () => {
    const themesDir = makeThemesDir();
    NodeFS.writeFileSync(NodePath.join(themesDir, "secret.png"), PNG);
    expect(findStoredThemeBackground(themesDir, "../secret")).toBeNull();
    expect(findStoredThemeBackground(themesDir, "A".repeat(64))).toBeNull();
  });

  it("stops keeping new pictures at the cap, and still accepts one it already has", () => {
    const themesDir = makeThemesDir();
    const directory = themeBackgroundDirectory(themesDir);
    NodeFS.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < MAX_STORED_THEME_BACKGROUNDS; index += 1) {
      NodeFS.writeFileSync(NodePath.join(directory, `${String(index).padStart(64, "0")}.png`), PNG);
    }
    expect(storeThemeBackground(themesDir, JPEG)).toMatchObject({ ok: false, status: 507 });
    NodeFS.writeFileSync(NodePath.join(directory, `${sha256(WEBP)}.webp`), WEBP);
    expect(storeThemeBackground(themesDir, WEBP)).toEqual({ ok: true, hash: sha256(WEBP) });
  });
});

const layerTest = AssetSigner.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-theme-bg-upload-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer)),
);

describe("theme background upload", () => {
  it.effect("stores a body that matches the signed size and answers with its hash", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueThemeBackgroundUploadUrl({ sizeBytes: PNG.length });
      const claims = yield* validateThemeBackgroundUploadToken(
        issued.relativeUrl.slice(`${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/`.length),
      );
      if (!claims) throw new Error("Expected upload claims");
      // Chunked, as a real request body is.
      const body = Stream.make(PNG.subarray(0, 5), PNG.subarray(5));
      expect(yield* storeThemeBackgroundUpload(claims, body)).toEqual({
        ok: true,
        hash: sha256(PNG),
      });
      expect(findStoredThemeBackground(config.environmentThemesDir, sha256(PNG))).not.toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses a body of another size than the one signed", () =>
    Effect.gen(function* () {
      const issued = yield* issueThemeBackgroundUploadUrl({ sizeBytes: PNG.length });
      const claims = yield* validateThemeBackgroundUploadToken(
        issued.relativeUrl.slice(`${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/`.length),
      );
      if (!claims) throw new Error("Expected upload claims");
      expect(
        yield* storeThemeBackgroundUpload(claims, Stream.make(PNG.subarray(0, PNG.length - 1))),
      ).toMatchObject({ ok: false, status: 400 });
      expect(
        yield* storeThemeBackgroundUpload(claims, Stream.make(PNG, Buffer.from("extra"))),
      ).toMatchObject({ ok: false, status: 400 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "keeps the cap when uploads arrive together, and answers copies of one picture alike",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const directory = themeBackgroundDirectory(config.environmentThemesDir);
        NodeFS.mkdirSync(directory, { recursive: true });
        for (let index = 0; index < MAX_STORED_THEME_BACKGROUNDS - 2; index += 1) {
          NodeFS.writeFileSync(
            NodePath.join(directory, `${String(index).padStart(64, "0")}.png`),
            PNG,
          );
        }
        const gate = yield* Deferred.make<void>();
        const upload = (bytes: Buffer) =>
          Effect.gen(function* () {
            const issued = yield* issueThemeBackgroundUploadUrl({ sizeBytes: bytes.length });
            const claims = yield* validateThemeBackgroundUploadToken(
              issued.relativeUrl.slice(`${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/`.length),
            );
            if (!claims) throw new Error("Expected upload claims");
            // Every body waits for the same gate, so all the uploads reach the store together.
            return yield* storeThemeBackgroundUpload(
              claims,
              Stream.fromEffect(Deferred.await(gate)).pipe(
                Stream.flatMap(() => Stream.make(bytes)),
              ),
            );
          });
        const pictures = [1, 2, 3, 4, 5].map((n) => Buffer.concat([PNG, Buffer.from(`#${n}`)]));
        // The gate opens only once every upload is waiting on it.
        const [results] = yield* Effect.all(
          [
            Effect.all([...pictures.map(upload), upload(JPEG), upload(JPEG), upload(JPEG)], {
              concurrency: "unbounded",
            }),
            Deferred.succeed(gate, undefined),
          ],
          { concurrency: "unbounded" },
        );
        const [first, second, third] = results.slice(pictures.length, pictures.length + 3);
        // Two free slots: exactly two of the six different pictures are kept, never more.
        expect(NodeFS.readdirSync(directory)).toHaveLength(MAX_STORED_THEME_BACKGROUNDS);
        const kept = results.slice(0, pictures.length).filter((result) => result.ok).length;
        expect(kept + (first?.ok ? 1 : 0)).toBe(2);
        // The same bytes sent together get one answer, never a 500.
        expect(second).toEqual(first);
        expect(third).toEqual(first);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts only a token it signed", () =>
    Effect.gen(function* () {
      const issued = yield* issueThemeBackgroundUploadUrl({ sizeBytes: 10 });
      const token = issued.relativeUrl.slice(`${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/`.length);
      expect(yield* validateThemeBackgroundUploadToken(token)).not.toBeNull();
      const [payload, signature] = token.split(".");
      expect(yield* validateThemeBackgroundUploadToken(`${payload}.${signature}x`)).toBeNull();
      expect(yield* validateThemeBackgroundUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );
});
