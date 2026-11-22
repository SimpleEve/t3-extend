# Release procedure

English | [简体中文](./release.zh-CN.md)

This is the one procedure every T3 Extend release follows. The release is built by `.github/workflows/fork-release.yml` on GitHub-hosted runners and published to the Releases of `SimpleEve/t3-extend`. The artifact table, the secrets and the local build commands are in [FORK.md](../FORK.md) under "打包与签名".

## 1. Version and tag rules

- A published tag is `v<upstream X.Y.Z>-<fork A.B>`, like `v0.1.11-1.7`. The first half is the upstream T3 Code release the fork last merged. The second half is the fork's own number, which keeps counting up across upstream syncs. The app's version is the tag without the `v`; the build sets it, so no `package.json` edit is needed.
- A new tag must be greater than every published tag under semver, numerically in both halves (`-1.10` is above `-1.9`). `t3x update` takes the first non-draft release in the list that has its channel, and the list is ordered by creation, not by version, so a lower tag published later would be offered as the newest. The workflow's plan job refuses a tag that breaks this. The upstream half must also move past a plain `X.Y.Z` that is already out (`0.1.10-9.0` is below `0.1.10`).
- `-nightly.` and `-preview.` suffixes are other channels. Never use them.
- Android derives its version from the tag: `versionName` `2.3.0-<A.B>`, `versionCode` `A × 1000 + B`. It only rises, so a new APK installs over an old one.
- Test builds use `v0.0.0-ci.N` (or any `vX.Y.Z-ci.N`). They are always draft prereleases and no client sees them.
- A published tag is never moved, deleted or reused. Fix a bad release with the next number.

## 2. Before you tag

1. Releases come from `main`. Confirm that `HEAD` is the commit you mean to ship and is pushed: `git status` is clean and `git fetch origin && git rev-parse HEAD origin/main` shows the same SHA.
2. `vp run fork:guard` passes.
3. The version is free and higher than the last published one: `gh release list -R SimpleEve/t3-extend --limit 5`. Use `-R`; a bare `gh` may point at upstream.
4. If the upstream half changes, the sync is already merged and recorded in `docs/fork/upstream.md`.

## 3. Write the changelog

Every release has `docs/fork/changelog/<version>.md` (the version without `v`). The release body is this file plus a short download list.

1. Draft it: `vp run fork:changelog --version <version>`. It finds the previous published fork tag reachable from `HEAD`, reads the first-parent history since then, and writes English items under `## English` and a `TODO(zh)` placeholder per item under `## 中文`. It never overwrites an existing file. Upstream syncs collapse into one item.
2. Rewrite both sections by hand in user-facing language. Say what changed for someone using the app, not the commit subject. Keep the same items in both languages, grouped under 新功能/Features, 修复/Fixes, 上游同步/Upstream, 其他/Other (leave out empty groups). Delete items that no user would notice.
3. Remove every `TODO`. The workflow refuses a published tag whose file is missing, has a `TODO`, or lacks either `## 中文` or `## English`.
4. Say it when installs need a manual step, such as an old version that cannot update itself.
5. Commit the file to `main` and push `main`.

The desktop update dialog shows only the section that matches the app language (`## 中文` for Chinese, `## English` otherwise), so keep each section complete on its own. Anything under a later `## ` heading, like the download list, is not shown.

## 4. Tag and push

```bash
git tag -a v<version> -m "T3 Extend <version>"
git push origin v<version>
```

Push the one tag by name, never `git push --tags`. The tag must point at the commit that has the changelog file.

## 5. What the workflow does

The `plan` job reads the tag, applies the rules in section 1 and checks the changelog, before any long build. Then it builds in parallel: the JS bundle and the three `t3x` archives, the signed macOS DMG and update zip, the Windows installer, and the Android APK. The `release` job downloads everything, checks that `latest-mac.yml` and `latest.yml` name files that exist with the digest and size they claim, writes the release body, creates the release as a draft with every asset attached, and only then publishes it as the latest release. A half-built release is never visible. Only one release run goes at a time; the next waits.

Watch it:

```bash
gh run list -R SimpleEve/t3-extend --workflow fork-release.yml --limit 3
gh run watch <run-id> -R SimpleEve/t3-extend --exit-status
```

## 6. After it publishes

1. `gh release view v<version> -R SimpleEve/t3-extend --json isDraft,isPrerelease,assets --jq '{isDraft,isPrerelease,assets:[.assets[].name]}'`. It must not be a draft or prerelease, and it must hold:
   - `T3-Extend-<version>-arm64.dmg`, `.dmg.sha256`, `T3-Extend-<version>-arm64.zip`, `latest-mac.yml`
   - `T3-Extend-<version>-x64.exe`, `.exe.sha256`, `.exe.blockmap`, `latest.yml`
   - `T3-Extend-<app version>-arm64-v8a.apk`, `.apk.sha256`
   - `t3-<version>-darwin-arm64.tar.gz`, `…-linux-x64.tar.gz`, `…-linux-arm64.tar.gz`, `SHA256SUMS`
2. Open the release page. The body shows `## 中文`, `## English` and `## 下载 / Downloads`, with no `TODO`.
3. Check that it is marked **Latest**: the desktop updater reads GitHub's latest release.
4. On a machine with the previous version installed (that version must already carry the updater), open the app and choose **Check for Updates…**. It must offer the new version, with the notes in the app language. Install it and check that the app starts on the new version. The first release that can update itself is 0.1.11-1.7, so the first real check is 0.1.11-1.7 to the next release.
5. Smoke-test one fresh install from the DMG or the installer.

How the desktop update works, so you know what to look at when it does not:

- The app has `app-update.yml` inside, written at build time from `T3CODE_DESKTOP_UPDATE_REPOSITORY` (the workflow sets it to `SimpleEve/t3-extend`). A build without that variable has no feed and no **Check for Updates…**.
- It asks GitHub for the latest release, reads `latest-mac.yml` or `latest.yml` from it, and offers the version when it is higher under semver. Drafts, prereleases and test builds are never the latest release.
- macOS: Squirrel.Mac only installs an update whose signature satisfies the running app's. Both come from the same self-signed identity, which is why the workflow checks `EXPECTED_MAC_CERT_SHA1`. A release signed with another certificate cannot update existing installs; users would install it by hand.
- Windows: the installer is unsigned and `app-update.yml` has no `publisherName`, so the updater checks only the SHA-512 in `latest.yml`.
- Installs of 0.1.11-1.6 and earlier have no updater. They install 0.1.11-1.7 by hand once.

## 7. Test builds

Try the pipeline without publishing:

```bash
git tag v0.0.0-ci.1 && git push origin v0.0.0-ci.1
# or, from a branch (the branch's workflow file runs):
gh workflow run fork-release.yml -R SimpleEve/t3-extend --ref <branch> -f version=0.0.0-ci.1
```

`workflow_dispatch` only accepts `-ci.N`; an empty version means `0.0.0-ci.<run number>`. A test build uses `docs/fork/changelog/<version>.md` if it exists and otherwise a fresh draft, and ends as a draft prerelease. Clean up when done:

```bash
gh release delete v0.0.0-ci.1 -R SimpleEve/t3-extend --yes --cleanup-tag
git tag -d v0.0.0-ci.1
```

## 8. When a build fails

- Read the failing job's log first.
- A transient failure (runner, network, a flaky download): `gh run rerun <run-id> -R SimpleEve/t3-extend --failed`. A rerun removes its own unfinished draft and builds a new one. It refuses a tag that is already published.
- A failure that needs a code fix: a rerun builds the commit the tag points at, so the fix does not ride along. If nothing was ever published under this tag, move it: delete the remote tag (`git push origin :refs/tags/v<version>`) and the local one (`git tag -d v<version>`), delete the draft release if there is one, commit the fix (and the changelog, if it changed) to `main`, then tag and push again.
- Never retag a published version. A bad published release gets the next number. To stop clients from being offered it meanwhile, turn it back into a draft: `gh release edit v<version> -R SimpleEve/t3-extend --draft`. `t3x update` and the desktop updater then skip it.
