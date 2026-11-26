// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  Effect.map(HostProcess.Platform, (platform) =>
    input.endsWith("/") || input.endsWith("\\")
      ? input
      : `${input}${platform === "win32" ? "\\" : "/"}`,
  );

it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it.effect("lists immediate children including ignored and empty directories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        yield* writeTextFile(cwd, "tracked.txt");
        yield* git(cwd, ["add", "tracked.txt"]);
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env\ntracked.txt\n");
        yield* writeTextFile(cwd, ".env", "secret=value");
        if (platform !== "win32") yield* writeTextFile(cwd, ":(draft).md");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* fileSystem.makeDirectory(path.join(cwd, "empty"));
        yield* git(cwd, ["init", "sub"]);
        yield* writeTextFile(cwd, "sub/.gitignore", "dist/\n");
        yield* writeTextFile(cwd, "sub/dist/out.js");
        const gitlink = yield* git(cwd, ["hash-object", "tracked.txt"]);
        yield* git(cwd, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},sub`]);
        // A nested clone that isn't a submodule keeps the outer repository's ignore rules.
        yield* git(cwd, ["init", "node_modules/pkg"]);
        yield* git(cwd, ["init", "sub/dist"]);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const root = yield* workspaceEntries.list({ cwd, directoryPath: "" });
        expect(root.entries).toEqual(
          expect.arrayContaining([
            { path: ".env", kind: "file", ignored: true },
            { path: "node_modules", kind: "directory", ignored: true },
            { path: "src", kind: "directory" },
            { path: "empty", kind: "directory" },
            { path: "tracked.txt", kind: "file" },
            ...(platform === "win32" ? [] : [{ path: ":(draft).md", kind: "file" }]),
          ]),
        );
        expect(root.entries.some((entry) => entry.path.includes("/"))).toBe(false);
        expect(root.entries.some((entry) => entry.path === ".git")).toBe(false);
        expect(root.truncated).toBe(false);
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "node_modules/pkg" })).toEqual({
          entries: [{ path: "node_modules/pkg/index.js", kind: "file", ignored: true }],
          truncated: false,
        });
        // Git refuses pathspecs inside a submodule from the outer repository.
        expect((yield* workspaceEntries.list({ cwd, directoryPath: "sub" })).entries).toEqual(
          expect.arrayContaining([
            { path: "sub/.gitignore", kind: "file" },
            { path: "sub/dist", kind: "directory", ignored: true },
          ]),
        );
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "sub/dist" })).toEqual({
          entries: [{ path: "sub/dist/out.js", kind: "file", ignored: true }],
          truncated: false,
        });
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "empty" })).toEqual({
          entries: [],
          truncated: false,
        });
      }),
    );

    it.effect("lists symlinks as what they point to, marked with where they lead", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        const cwd = yield* makeTempDir({ git: true });
        const outside = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "real.txt");
        yield* writeTextFile(cwd, "realdir/nested.txt");
        yield* writeTextFile(outside, "outside.txt");
        yield* writeTextFile(outside, "deeper/inner.txt");
        yield* fileSystem.symlink("real.txt", path.join(cwd, "link.txt"));
        yield* fileSystem.symlink("realdir", path.join(cwd, "linkdir"));
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));
        yield* fileSystem.symlink(path.join(outside, "outside.txt"), path.join(cwd, "outside.txt"));
        yield* fileSystem.symlink(".git", path.join(cwd, "git-link"));
        yield* fileSystem.symlink("missing", path.join(cwd, "dangling"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const root = yield* workspaceEntries.list({ cwd, directoryPath: "" });
        expect(root.entries.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: "dangling", kind: "file", symlink: { target: "missing", broken: true } },
          // An ordinary link that stays inside only needs the mark.
          { path: "link.txt", kind: "file", symlink: {} },
          { path: "linkdir", kind: "directory", symlink: {} },
          { path: "outside-link", kind: "directory", symlink: { target: outside } },
          {
            path: "outside.txt",
            kind: "file",
            symlink: { target: path.join(outside, "outside.txt") },
          },
          { path: "real.txt", kind: "file" },
          { path: "realdir", kind: "directory" },
        ]);
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "linkdir" })).toEqual({
          entries: [{ path: "linkdir/nested.txt", kind: "file" }],
          truncated: false,
        });
        // A link out of the workspace opens like any other folder; what it holds is listed
        // under the lexical path, and links inside it resolve the same way.
        const listedOutside = yield* workspaceEntries.list({
          cwd,
          directoryPath: "outside-link",
        });
        expect(listedOutside.entries.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: "outside-link/deeper", kind: "directory" },
          { path: "outside-link/outside.txt", kind: "file" },
        ]);
        expect(
          (yield* workspaceEntries.list({ cwd, directoryPath: "outside-link/deeper" })).entries,
        ).toEqual([{ path: "outside-link/deeper/inner.txt", kind: "file" }]);
      }),
    );

    it.effect("keeps links into the workspace's own .git out of the list", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.symlink(".git", path.join(cwd, "git-link"));
        yield* fileSystem.symlink(".git/HEAD", path.join(cwd, "head-link"));
        yield* writeTextFile(cwd, "kept.txt");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(
          (yield* workspaceEntries.list({ cwd, directoryPath: "" })).entries.map(
            (entry) => entry.path,
          ),
        ).toEqual(["kept.txt"]);
        const error = yield* workspaceEntries
          .list({ cwd, directoryPath: "git-link" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceEntriesReadDirectoryError");
      }),
    );

    it.effect(
      "lists folder links that lead back to a folder on the listed path, not expandable",
      () =>
        // "Expand all folders" loads every folder it expands, so a link that loops would
        // keep nesting the same entries without end. Clients leave a `cycle` link closed.
        Effect.gen(function* () {
          const platform = yield* HostProcess.Platform;
          if (platform === "win32") return;
          const cwd = yield* makeTempDir();
          const outside = yield* makeTempDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, "a/file.txt");
          yield* writeTextFile(cwd, "b/file.txt");
          yield* writeTextFile(outside, "x.txt");
          yield* fileSystem.symlink(".", path.join(cwd, "self"));
          yield* fileSystem.symlink("..", path.join(cwd, "a/up"));
          yield* fileSystem.symlink("../b", path.join(cwd, "a/to-b"));
          yield* fileSystem.symlink("../a", path.join(cwd, "b/to-a"));
          yield* fileSystem.symlink(outside, path.join(cwd, "away"));
          yield* fileSystem.symlink(path.join(cwd, "away"), path.join(outside, "back-to-away"));
          yield* fileSystem.symlink(cwd, path.join(outside, "back-to-workspace"));

          const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
          const list = (directoryPath: string) =>
            workspaceEntries
              .list({ cwd, directoryPath })
              .pipe(
                Effect.map(({ entries }) =>
                  entries.toSorted((a, b) => a.path.localeCompare(b.path)),
                ),
              );
          const root = yield* list("");
          expect(root.map((entry) => [entry.path, entry.symlink?.cycle === true])).toEqual([
            ["a", false],
            ["away", false],
            ["b", false],
            ["self", true],
          ]);
          // Clients that predate `cycle` expand every directory, so a loop is never sent as one.
          expect(root.find((entry) => entry.path === "self")).toEqual({
            path: "self",
            kind: "file",
            symlink: { target: ".", cycle: true },
          });
          for (const directoryPath of ["", "a", "a/to-b", "away"]) {
            for (const entry of yield* list(directoryPath)) {
              if (entry.symlink?.cycle) expect(entry.kind).toBe("file");
            }
          }
          // A link into a sibling folder is fine on its own...
          expect(
            (yield* list("a")).map((entry) => [entry.path, entry.symlink?.cycle === true]),
          ).toEqual([
            ["a/file.txt", false],
            ["a/to-b", false],
            ["a/up", true],
          ]);
          // ...but once followed, the sibling's link back is marked.
          expect(
            (yield* list("a/to-b")).map((entry) => [entry.path, entry.symlink?.cycle === true]),
          ).toEqual([
            ["a/to-b/file.txt", false],
            ["a/to-b/to-a", true],
          ]);
          // Inside a folder outside the workspace, a link back to it or to the workspace loops too.
          expect(
            (yield* list("away")).map((entry) => [entry.path, entry.symlink?.cycle === true]),
          ).toEqual([
            ["away/back-to-away", true],
            ["away/back-to-workspace", true],
            ["away/x.txt", false],
          ]);
        }),
    );

    // Stands in for a link into an unresponsive mount: `realpath` on a `hung-` link never settles
    // until the test releases it, as a stuck call only returns when the OS gives up.
    const withHungLinks = () => {
      const realpath = NodeFSP.realpath;
      const releases: Array<() => void> = [];
      const spy = vi.spyOn(NodeFSP, "realpath").mockImplementation((async (target: string) => {
        if (!/[\\/]hung-[^\\/]*$/.test(target)) return await realpath(target);
        return await new Promise<string>((_, reject) => {
          releases.push(() => reject(new Error("released")));
        });
      }) as typeof NodeFSP.realpath);
      return {
        count: () => releases.length,
        release: () => {
          spy.mockRestore();
          for (const release of releases.splice(0)) release();
        },
      };
    };

    it.effect("lists links it cannot follow in time as unresolved, holding only two lookups", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        const cwd = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "real.txt");
        const names = Array.from({ length: 6 }, (_, index) => `hung-${index}`);
        for (const name of names) {
          yield* fileSystem.symlink("real.txt", path.join(cwd, name));
        }
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const list = workspaceEntries
          .list({ cwd, directoryPath: "" })
          .pipe(
            Effect.map(({ entries }) => entries.toSorted((a, b) => a.path.localeCompare(b.path))),
          );
        const unresolved = [
          ...names.map((name) => ({
            path: name,
            kind: "file",
            symlink: { target: "real.txt", unresolved: true },
          })),
          { path: "real.txt", kind: "file" },
        ];
        const hung = withHungLinks();
        yield* Effect.gen(function* () {
          expect(yield* list).toEqual(unresolved);
          // The links past the cap never started a call that could take another worker.
          expect(hung.count()).toBe(2);
          // While both slots are stuck, another listing gives up without starting anything.
          expect(yield* list).toEqual(unresolved);
          expect(hung.count()).toBe(2);
        }).pipe(Effect.ensuring(Effect.sync(hung.release)));
        // The stuck calls returned, so listing again resolves the links.
        expect((yield* list).filter((entry) => entry.symlink)).toEqual(
          names.map((name) => ({ path: name, kind: "file", symlink: {} })),
        );
      }),
    );

    it.effect("keeps resolving the other links while one lookup is stuck", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        const cwd = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "real.txt");
        yield* writeTextFile(cwd, "mixed/.keep");
        yield* writeTextFile(cwd, "healthy/.keep");
        const links = Array.from({ length: 150 }, (_, index) => `link-${index}`);
        for (const name of [
          "mixed/hung-only",
          ...links.flatMap((link) => [`mixed/${link}`, `healthy/${link}`]),
        ]) {
          yield* fileSystem.symlink("../real.txt", path.join(cwd, name));
        }
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const hung = withHungLinks();
        yield* Effect.gen(function* () {
          // Two listings at once queue for the same slots; waiting for a busy slot is not failure.
          const results = yield* Effect.forEach(
            ["mixed", "healthy"],
            (directoryPath) => workspaceEntries.list({ cwd, directoryPath }),
            { concurrency: 2 },
          );
          expect(
            results.map(({ entries }) =>
              entries.filter((entry) => entry.symlink?.unresolved).map((entry) => entry.path),
            ),
          ).toEqual([["mixed/hung-only"], []]);
        }).pipe(Effect.ensuring(Effect.sync(hung.release)));
      }),
    );

    it.effect("resolves a folder of many symlinks a few at a time", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        const cwd = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Shaped like a pnpm `node_modules`: one link per package into `.pnpm`.
        const directoryPath = [...Array.from({ length: 80 }, () => "nested"), "node_modules"].join(
          "/",
        );
        const packages = Array.from({ length: 200 }, (_, index) => `pkg-${index}`);
        yield* Effect.forEach(
          packages,
          (name) =>
            Effect.gen(function* () {
              yield* writeTextFile(cwd, `${directoryPath}/.pnpm/${name}/index.js`);
              yield* fileSystem.symlink(`.pnpm/${name}`, path.join(cwd, directoryPath, name));
            }),
          { concurrency: 32, discard: true },
        );
        const realpath = NodeFSP.realpath;
        let inFlight = 0;
        let maxInFlight = 0;
        vi.spyOn(NodeFSP, "realpath").mockImplementation((async (target: string) => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          try {
            return await realpath(target);
          } finally {
            inFlight--;
          }
        }) as typeof NodeFSP.realpath);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const { entries } = yield* workspaceEntries.list({ cwd, directoryPath });
        expect(entries.map((entry) => entry.path).toSorted()).toEqual(
          [
            `${directoryPath}/.pnpm`,
            ...packages.map((name) => `${directoryPath}/${name}`),
          ].toSorted(),
        );
        expect(entries.every((entry) => entry.kind === "directory")).toBe(true);
        // Each in-flight call can hold a libuv worker, of which there are four.
        expect(maxInFlight).toBeLessThanOrEqual(2);
      }),
    );

    it.effect("labels the children of wide folders exactly as git does for each child", () =>
      Effect.gen(function* () {
        // Above 1,000 children, listing first asks whether the whole folder is ignored.
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\ndist/\n\\[id\\]/\n*.map\n:foo/\n");
        yield* Effect.forEach(
          [
            "node_modules",
            "dist",
            "[id]",
            "src",
            ...(platform !== "win32" ? [":foo"] : []),
          ].flatMap((directory) =>
            Array.from({ length: 1001 }, (_, index) => `${directory}/pkg-${index}.js`),
          ),
          (relativePath) => writeTextFile(cwd, relativePath),
          { concurrency: 32, discard: true },
        );
        for (const relativePath of [
          "dist/kept.js",
          "dist/vendored/index.js",
          "i/page.tsx",
          "[id]/page.tsx",
          "src/bundle.map",
        ]) {
          yield* writeTextFile(cwd, relativePath);
        }
        yield* git(cwd, ["add", "-f", "dist/kept.js", "dist/vendored/index.js", "i/page.tsx"]);
        if (platform !== "win32") {
          yield* fileSystem.symlink(path.join(cwd, "src"), path.join(cwd, "node_modules/link"));
        }

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const { directoryPath, ignored, except } of [
          { directoryPath: "node_modules", ignored: true, except: [] },
          { directoryPath: "dist", ignored: true, except: ["dist/kept.js", "dist/vendored"] },
          // git reads `[id]/page.tsx` as a pathspec, which matches the tracked `i/page.tsx`.
          { directoryPath: "[id]", ignored: true, except: ["[id]/page.tsx"] },
          { directoryPath: "src", ignored: false, except: ["src/bundle.map"] },
          ...(platform !== "win32"
            ? [
                // git refuses to classify paths beyond a symlink, so nothing there is labelled.
                { directoryPath: "node_modules/link", ignored: false, except: [] },
                // Git reads ./:foo literally, so :foo/ in .gitignore labels the whole folder.
                { directoryPath: ":foo", ignored: true, except: [] },
              ]
            : []),
        ]) {
          const { entries } = yield* workspaceEntries.list({ cwd, directoryPath });
          expect(entries.length, directoryPath).toBeGreaterThan(1000);
          expect(
            entries
              .filter((entry) => (entry.ignored === true) !== ignored)
              .map((entry) => entry.path)
              .toSorted(),
            directoryPath,
          ).toEqual(except);
        }
      }),
    );

    it.effect("lists a host folder and its parent, each from its own root", () =>
      Effect.gen(function* () {
        const parent = yield* makeTempDir();
        const path = yield* Path.Path;
        yield* writeTextFile(parent, "linked/notes.md");
        yield* writeTextFile(parent, "sibling/readme.md");
        const linked = path.join(parent, "linked");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.list({ cwd: linked, directoryPath: "" })).toEqual({
          entries: [{ path: "notes.md", kind: "file" }],
          truncated: false,
        });
        const up = yield* workspaceEntries.list({ cwd: parent, directoryPath: "" });
        expect(up.entries.map((entry) => entry.path).toSorted()).toEqual(["linked", "sibling"]);
        const escape = yield* workspaceEntries
          .list({ cwd: linked, directoryPath: "../sibling" })
          .pipe(Effect.flip);
        expect(escape._tag).toBe("WorkspaceEntriesReadDirectoryError");
      }),
    );

    it.effect("rejects directory traversal, git internals, and absolute paths", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const outside = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, ".git/HEAD");
        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") yield* fileSystem.symlink(outside, path.join(cwd, "external"));
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        // A link that leaves the workspace is listable, but never by walking out with `..`.
        for (const directoryPath of [
          "../",
          outside,
          ".git",
          "missing",
          ...(platform !== "win32" ? ["external/.."] : []),
        ]) {
          const error = yield* workspaceEntries.list({ cwd, directoryPath }).pipe(Effect.flip);
          expect(error._tag).toBe("WorkspaceEntriesReadDirectoryError");
        }
      }),
    );

    it.effect("includes images and other binary files in non-git workspace indexes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const imagePaths = ["photo.png", "photo.jpg", "photo.jpeg"];
        const binaryPaths = [...imagePaths, "document.pdf", "archive.zip", "data.bin"];
        for (const filePath of binaryPaths) {
          yield* writeTextFile(cwd, filePath, "\0binary contents\n");
        }
        yield* writeTextFile(cwd, "notes.txt", "plain text\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const expectedPaths = [...binaryPaths, "notes.txt"].toSorted();
        const listed = yield* workspaceEntries.list({ cwd });
        expect(listed.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(listed.truncated).toBe(false);

        const searched = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          kind: "file",
        });
        expect(searched.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(searched.truncated).toBe(false);

        const images = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          imageOnly: true,
        });
        expect(images.entries.map((entry) => entry.path).toSorted()).toEqual(imagePaths.toSorted());
        expect(images.truncated).toBe(false);
      }),
    );
  });

  describe("listIgnoredFiles", () => {
    it.effect("lists ignored files with sizes and skips wholly ignored folders", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env*\n");
        yield* writeTextFile(cwd, ".env", "A=1");
        yield* writeTextFile(cwd, "apps/web/index.ts", "y");
        yield* git(cwd, ["add", "apps/web/index.ts"]);
        yield* writeTextFile(cwd, "apps/web/.env.local", "B=22");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "x");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.listIgnoredFiles({ cwd })).toEqual({
          files: [
            { path: ".env", byteLength: 3 },
            { path: "apps/web/.env.local", byteLength: 4 },
          ],
          truncated: false,
        });
      }),
    );

    it.effect("finds ignored files that sort past the listing limit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", "*.secret\n");
        for (let index = 1; index <= 205; index += 1) {
          yield* writeTextFile(cwd, `file-${String(index).padStart(3, "0")}.secret`, "s");
        }

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const listed = yield* workspaceEntries.listIgnoredFiles({ cwd, query: "file-205" });
        expect(listed.files).toContainEqual({ path: "file-205.secret", byteLength: 1 });
      }),
    );
  });

  describe("search", () => {
    it.effect("applies the file filter before limiting search results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-file-limit-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "src/internal.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 1,
          kind: "file",
        });

        // Native ranking can put either matching file first.
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.kind).toBe("file");
        expect(["src/index.ts", "src/internal.ts"]).toContain(result.entries[0]?.path);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("matches glob metacharacters in the query literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-brackets-" });
        yield* writeTextFile(cwd, "src/app/game/[id]/index.tsx");
        yield* writeTextFile(cwd, "src/foo{bar}.ts");
        yield* writeTextFile(cwd, "src/main.ts");
        yield* writeTextFile(cwd, "src/notes.md");

        const search = (query: string) =>
          searchWorkspaceEntries({ cwd, query, limit: 10 }).pipe(
            Effect.map((result) => result.entries.map((entry) => entry.path)),
          );

        for (const query of ["game/[i", "game/[id]"]) {
          expect(yield* search(query)).toContain("src/app/game/[id]/index.tsx");
        }
        expect(yield* search("foo{bar}.ts")).toContain("src/foo{bar}.ts");
        expect((yield* search("*.{ts,tsx}")).toSorted()).toEqual([
          "src/app/game/[id]/index.tsx",
          "src/foo{bar}.ts",
          "src/main.ts",
        ]);
        expect((yield* search("*.{ts}")).toSorted()).toEqual(["src/foo{bar}.ts", "src/main.ts"]);
        expect(yield* search("src/{main}.ts")).toEqual(["src/main.ts"]);
        expect(yield* search("src/{foo{bar},notes}.md")).toEqual(["src/notes.md"]);
      }),
    );

    it.effect("excludes gitignored paths for git repositories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-gitignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* writeTextFile(cwd, "ignored.txt", "ignore me");
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");
        yield* writeTextFile(cwd, ".git/info/exclude", "info-excluded.txt\n");
        yield* writeTextFile(cwd, "info-excluded.txt", "ignore me");
        yield* writeTextFile(cwd, ".git/configured-excludes", "configured-excluded.txt\n");
        yield* git(cwd, ["config", "core.excludesFile", ".git/configured-excludes"]);
        yield* writeTextFile(cwd, "configured-excluded.txt", "ignore me");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("ignored.txt");
        expect(paths).not.toContain("info-excluded.txt");
        expect(paths).not.toContain("configured-excluded.txt");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("convex/"))).toBe(false);
      }),
    );

    it.effect("excludes tracked paths that match ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({
          prefix: "t3code-workspace-tracked-gitignore-",
          git: true,
        });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* git(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
        yield* writeTextFile(cwd, ".gitignore", ".convex/\n");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("indexes symlinked files and directories inside the workspace", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-symlinks-" });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "src/index.ts", "export {};");
        yield* fileSystem.symlink("src", path.join(cwd, "src-link"));
        yield* fileSystem.symlink("src/index.ts", path.join(cwd, "index-link.ts"));
        const symlinkEntries = [
          { kind: "directory", path: "src-link" },
          { kind: "file", path: "index-link.ts" },
        ];

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entry of symlinkEntries) {
          expect(searched.entries).toContainEqual(expect.objectContaining(entry));
          expect(listed.entries).toContainEqual(expect.objectContaining(entry));
        }
      }),
    );
    it.effect("skips symlinks that ignore rules hide or that leave the workspace", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-symlinks-", git: true });
        const outside = yield* makeTempDir({ prefix: "t3code-workspace-symlinks-outside-" });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "src/index.ts", "export {};");
        yield* writeTextFile(cwd, ".ignore", "custom-link\n");
        yield* fileSystem.symlink("src", path.join(cwd, "custom-link"));
        yield* fileSystem.symlink("src/index.ts", path.join(cwd, "tracked-link.ts"));
        yield* fileSystem.symlink("src", path.join(cwd, "ignored-link"));
        yield* fileSystem.symlink("src", path.join(cwd, "kept-link"));
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));
        yield* git(cwd, ["add", "tracked-link.ts"]);
        yield* writeTextFile(cwd, ".gitignore", "tracked-link.ts\nignored-link\n");
        // A submodule path makes `git check-ignore` refuse the whole batch without --no-index.
        const submodule = path.join(cwd, "vendor/sub");
        yield* writeTextFile(submodule, "a.ts", "export {};");
        yield* git(submodule, ["init"]);
        yield* git(submodule, ["add", "a.ts"]);
        yield* git(submodule, [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "-m",
          "init",
        ]);
        yield* git(cwd, ["add", "vendor/sub"]);
        yield* fileSystem.symlink("a.ts", path.join(submodule, "sublink.ts"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entries of [searched.entries, listed.entries]) {
          const paths = entries.map((entry) => entry.path);
          expect(paths).toContain("kept-link");
          expect(paths).toContain("vendor/sub/sublink.ts");
          expect(paths).not.toContain("custom-link");
          expect(paths).not.toContain("tracked-link.ts");
          expect(paths).not.toContain("ignored-link");
          expect(paths).not.toContain("outside-link");
        }
      }),
    );
    it.effect("lets the nearest .ignore rule decide a symlink, ahead of git's rules", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-symlinks-", git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, ".gitignore", "*keep*\n");
        yield* writeTextFile(cwd, ".ignore", "!*keep*\n*hide*\n");
        yield* writeTextFile(cwd, "sub/.ignore", "!*hide*\n");
        yield* writeTextFile(cwd, "keep-real.ts", "export {};");
        yield* writeTextFile(cwd, "sub/hide-real.ts", "export {};");
        yield* fileSystem.symlink("keep-real.ts", path.join(cwd, "keep-link.ts"));
        yield* fileSystem.symlink("hide-real.ts", path.join(cwd, "sub/hide-link.ts"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entries of [searched.entries, listed.entries]) {
          const paths = entries.map((entry) => entry.path);
          expect(paths).toContain("sub/hide-link.ts");
          expect(paths).toContain("keep-link.ts");
        }
        // The real files are shown or hidden by the same rules.
        const listedPaths = listed.entries.map((entry) => entry.path);
        expect(listedPaths).toContain("sub/hide-real.ts");
        expect(listedPaths).toContain("keep-real.ts");
      }),
    );
    it.effect("matches .ignore rules against whole names and treats folder links as links", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-symlinks-", git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "src/index.ts", "export {};");
        yield* writeTextFile(cwd, ".gitignore", "blink\n");
        // `!link` must not re-include `blink`, and `folder-link/` does not apply to a link.
        yield* writeTextFile(cwd, ".ignore", "!link\nfolder-link/\n");
        yield* fileSystem.symlink("src", path.join(cwd, "blink"));
        yield* fileSystem.symlink("src", path.join(cwd, "folder-link"));
        yield* writeTextFile(cwd, "sub/blink", "regular");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entries of [searched.entries, listed.entries]) {
          const paths = entries.map((entry) => entry.path);
          expect(paths).not.toContain("blink");
          expect(paths).not.toContain("sub/blink");
          expect(paths).toContain("folder-link");
        }
      }),
    );
    it.effect("finds a path inside a gitignored nested git worktree only by its exact path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-worktree-", git: true });
        const env = {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        };
        yield* writeTextFile(cwd, ".gitignore", ".worktrees/\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "init"], env);
        yield* git(cwd, ["worktree", "add", "-b", "x", ".worktrees/x"]);
        yield* writeTextFile(cwd, ".worktrees/x/src/foo.py", "print(1)");
        const expected = [".worktrees/x/src/foo.py"];
        // Windows file names cannot contain a newline.
        if ((yield* HostProcess.Platform) !== "win32") {
          yield* git(cwd, ["worktree", "add", "--detach", ".worktrees/line\nname"]);
          yield* writeTextFile(cwd, ".worktrees/line\nname/src/foo.py", "print(2)");
          expected.unshift(".worktrees/line\nname/src/foo.py");
        }

        const exact = yield* searchWorkspaceEntries({
          cwd,
          query: "src/foo.py",
          limit: 25,
          kind: "file",
        });
        expect(exact.entries.toSorted((a, b) => (a.path < b.path ? -1 : 1))).toEqual(
          expected.map((path) => ({ path, kind: "file" })),
        );

        const partial = yield* searchWorkspaceEntries({ cwd, query: "src/fo", limit: 25 });
        for (const path of expected) {
          expect(partial.entries.map((entry) => entry.path)).not.toContain(path);
        }
      }),
    );

    it.effect("releases an index nobody searched within the idle timeout on refresh", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-idle-refresh-" });
        yield* writeTextFile(cwd, "src/index.ts");
        let rescans = 0;
        let destroyed = 0;
        const createFinder = FileFinder.create.bind(FileFinder);
        vi.spyOn(FileFinder, "create").mockImplementation((options) => {
          const created = createFinder(options);
          if (created.ok) {
            const finder = created.value;
            const scanFilesAsync = finder.scanFilesAsync.bind(finder);
            finder.scanFilesAsync = () => {
              rescans += 1;
              return scanFilesAsync();
            };
            const destroy = finder.destroy.bind(finder);
            finder.destroy = () => {
              destroyed += 1;
              destroy();
            };
          }
          return created;
        });
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        yield* TestClock.adjust("1 hour");
        yield* searchWorkspaceEntries({ cwd, query: "index", limit: 10 });

        for (let run = 0; run < 3; run++) {
          yield* TestClock.adjust("6 minutes");
          yield* workspaceEntries.refresh(cwd);
        }

        expect({ rescans, destroyed }).toEqual({ rescans: 2, destroyed: 1 });
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  describe("searchContents", () => {
    it.effect("returns content matches with file paths, line numbers, and ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-search-" });
        yield* writeTextFile(
          cwd,
          "src/shapes.ts",
          "export const square = 4;\nexport const Square = 16;\nexport const squareSize = 8;\n",
        );
        yield* writeTextFile(cwd, "src/other.ts", "const circle = true;\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: false,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([
          ["src/shapes.ts", 1],
          ["src/shapes.ts", 2],
        ]);
        expect(result.matches[0]?.matchRanges).toEqual([{ start: 13, end: 19 }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("honors case sensitivity and gitignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-ignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "square\nSquare\n");
        yield* writeTextFile(cwd, "ignored.txt", "Square\n");
        yield* writeTextFile(cwd, ".git/info/exclude", "info-excluded.txt\n");
        yield* writeTextFile(cwd, "info-excluded.txt", "Square\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ path: "src/keep.ts", lineNumber: 2 });
      }),
    );

    it.effect("finds later whole-word matches in a file after rejected raw matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-late-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", `${"afoo\n".repeat(10)}foo\n`);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 1,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 11,
            matchRanges: [{ start: 0, end: 3 }],
          }),
        ]);
      }),
    );

    it.effect("treats astral-plane letters as whole word characters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-astral-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "𐐀foo foo foo𐐀\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 6, end: 9 }],
          }),
        ]);
      }),
    );

    it.effect("matches punctuation-edged whole-word queries including adjacent occurrences", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "-foo- -foo- -foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "-foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 5 },
            { start: 6, end: 11 },
            { start: 12, end: 17 },
          ],
        });
      }),
    );

    it.effect("caps matches per file so one dense file cannot fill the page", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-per-file-cap-" });
        yield* writeTextFile(cwd, "src/dense.ts", "needle\n".repeat(300));
        yield* writeTextFile(cwd, "src/other.ts", "needle\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "needle",
          limit: 500,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        const byPath = new Map<string, number>();
        for (const match of result.matches) {
          byPath.set(match.path, (byPath.get(match.path) ?? 0) + 1);
        }
        expect(byPath.get("src/dense.ts")).toBe(100);
        expect(byPath.get("src/other.ts")).toBe(1);
      }),
    );

    it.effect("preserves regex escapes during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "Square\nsquare\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "\\SQUARE",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      }),
    );

    it.effect("searches an invalid regex literally without matching case", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-invalid-regex-" });
        yield* writeTextFile(cwd, "src/calls.ts", "call(Foo(bar));\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo(",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.regexFallbackError).toBeDefined();
        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/calls.ts",
            lineNumber: 1,
            matchRanges: [{ start: 5, end: 9 }],
          }),
        ]);
      }),
    );

    it.effect("maps multi-byte lines to string-indexed ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-multibyte-" });
        yield* writeTextFile(cwd, "src/notes.ts", 'const label = "héllo wörld";\n');

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "wörld",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        const match = result.matches[0]!;
        const range = match.matchRanges[0]!;
        expect(match.lineContent.slice(range.start, range.end)).toBe("wörld");
      }),
    );

    it.effect("keeps matches past the truncated part of a long line", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-long-line-" });
        yield* writeTextFile(cwd, "dist/app.min.js", `${"x".repeat(600)} needleSuffix\n`);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const search = (wholeWord: boolean) =>
          workspaceEntries.searchContents({
            cwd,
            query: "needle",
            limit: 100,
            caseSensitive: true,
            wholeWord,
            useRegex: false,
          });

        expect((yield* search(false)).matches).toEqual([
          expect.objectContaining({ path: "dist/app.min.js", lineNumber: 1 }),
        ]);
        expect((yield* search(true)).matches).toEqual([]);
      }),
    );

    it.effect("keeps answering from the live index when a refresh outlasts the scan wait", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-refresh-" });
        yield* writeTextFile(cwd, "src/notes.ts", "const needle = 1;\n");
        let scansOutlastWait = false;
        let finders = 0;
        let rescans = 0;
        const createFinder = FileFinder.create.bind(FileFinder);
        vi.spyOn(FileFinder, "create").mockImplementation((options) => {
          const created = createFinder(options);
          if (created.ok) {
            const finder = created.value;
            finders += 1;
            // The synchronous rescan and grep wait on fff's picker lock on the event loop.
            finder.scanFiles = () => {
              throw new Error("refresh must not rescan on the JS thread");
            };
            finder.grep = () => {
              throw new Error("search must not grep on the JS thread");
            };
            const scanFilesAsync = finder.scanFilesAsync.bind(finder);
            finder.scanFilesAsync = () => {
              rescans += 1;
              return scanFilesAsync();
            };
            const waitForIndexReady = finder.waitForIndexReady.bind(finder);
            finder.waitForIndexReady = (timeoutMs) =>
              scansOutlastWait
                ? Promise.resolve({ ok: true, value: false })
                : waitForIndexReady(timeoutMs);
          }
          return created;
        });
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searchNeedle = workspaceEntries.searchContents({
          cwd,
          query: "needle",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });
        yield* searchNeedle;

        scansOutlastWait = true;
        yield* workspaceEntries.refresh(cwd);
        const result = yield* searchNeedle;

        expect(result.matches.map((match) => match.path)).toEqual(["src/notes.ts"]);
        // The second search ran on the rescanned live finder, not a rebuild.
        expect({ finders, rescans }).toEqual({ finders: 1, rescans: 1 });
      }),
    );

    it.effect("serves content search once a first scan that outlasted the wait finishes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-slow-scan-" });
        yield* writeTextFile(cwd, "src/notes.ts", "const needle = 1;\n");
        // Real finders; only the initial wait and the progress it reads report a scan still running.
        let scanning = true;
        let finders = 0;
        let settle = (): Promise<unknown> => Promise.resolve();
        const createFinder = FileFinder.create.bind(FileFinder);
        vi.spyOn(FileFinder, "create").mockImplementation((options) => {
          const created = createFinder(options);
          if (!created.ok) return created;
          const finder = created.value;
          finders += 1;
          const waitForIndexReady = finder.waitForIndexReady.bind(finder);
          settle = () => waitForIndexReady(15_000);
          finder.waitForIndexReady = (timeoutMs) =>
            scanning ? Promise.resolve({ ok: true, value: false }) : waitForIndexReady(timeoutMs);
          const getScanProgress = finder.getScanProgressAsync.bind(finder);
          finder.getScanProgressAsync = async () => {
            const progress = await getScanProgress();
            return scanning && progress.ok
              ? {
                  ok: true,
                  value: { ...progress.value, isScanning: true, isWarmupComplete: false },
                }
              : progress;
          };
          return created;
        });
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searchNeedle = workspaceEntries
          .searchContents({
            cwd,
            query: "needle",
            limit: 100,
            caseSensitive: true,
            wholeWord: false,
            useRegex: false,
          })
          .pipe(
            Effect.map((result): unknown => result.matches.map((match) => match.path)),
            Effect.catchTags({
              WorkspaceSearchIndexScanTimedOut: (error) => Effect.succeed<unknown>(error._tag),
            }),
          );

        const whileScanning = yield* Effect.all([searchNeedle, searchNeedle], {
          concurrency: "unbounded",
        });
        scanning = false;
        yield* Effect.promise(() => settle());
        const afterScan = yield* searchNeedle;

        expect({ whileScanning, afterScan, finders }).toEqual({
          whileScanning: ["WorkspaceSearchIndexScanTimedOut", "WorkspaceSearchIndexScanTimedOut"],
          afterScan: ["src/notes.ts"],
          finders: 1,
        });
      }),
    );
  });

  describe("browse", () => {
    it.effect("shows dot directories in directory mode and hidden-prefix mode", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-hidden-" });
        yield* writeTextFile(cwd, ".config/settings.json", "{}");
        yield* writeTextFile(cwd, "config/settings.json", "{}");
        const cwdWithSeparator = yield* appendSeparator(cwd);

        const directoryResult = yield* workspaceEntries.browse({
          partialPath: cwdWithSeparator,
        });
        const hiddenPrefixResult = yield* workspaceEntries.browse({
          partialPath: `${cwdWithSeparator}.c`,
        });

        expect(directoryResult.entries.map((entry) => entry.name)).toEqual([".config", "config"]);
        expect(hiddenPrefixResult).toEqual({
          parentPath: cwd,
          entries: [{ name: ".config", fullPath: path.join(cwd, ".config") }],
        });
      }),
    );

    it.effect("marks only a missing directory as missing when browsing fails", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-missing-" });
        yield* writeTextFile(cwd, "file.txt", "");

        const missing = yield* workspaceEntries
          .browse({ partialPath: `${path.join(cwd, "absent", "nested")}${path.sep}` })
          .pipe(Effect.flip);
        const underFile = yield* workspaceEntries
          .browse({ partialPath: `${path.join(cwd, "file.txt")}${path.sep}` })
          .pipe(Effect.flip);

        expect(missing).toMatchObject({
          _tag: "WorkspaceEntriesReadDirectoryError",
          pathMissing: true,
        });
        expect(underFile).toMatchObject({
          _tag: "WorkspaceEntriesReadDirectoryError",
          pathMissing: false,
        });
      }),
    );

    it.effect("lists symlinks to directories under their link path", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-symlink-" });
        const externalTarget = yield* makeTempDir({
          prefix: "t3code-workspace-browse-symlink-target-",
        });
        yield* writeTextFile(cwd, "real-dir/readme.md", "hi");
        yield* writeTextFile(cwd, "plain.txt", "hi");

        yield* fileSystem.symlink(externalTarget, path.join(cwd, "personal"));
        yield* fileSystem.symlink(path.join(cwd, "plain.txt"), path.join(cwd, "file-link"));
        yield* fileSystem.symlink(path.join(cwd, "does-not-exist"), path.join(cwd, "broken-link"));

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
        });

        expect(result.entries).toEqual([
          { name: "personal", fullPath: path.join(cwd, "personal") },
          { name: "real-dir", fullPath: path.join(cwd, "real-dir") },
        ]);
      }),
    );
  });
});
