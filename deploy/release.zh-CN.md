# 发布流程

[English](./release.md) | 简体中文

T3 Extend 的每个版本都照这一份流程发。版本由 `.github/workflows/fork-release.yml` 在 GitHub 托管的 runner 上构建，发布到 `SimpleEve/t3-extend` 的 Releases。产物表、Secrets 和本机打包命令在 [FORK.md](../FORK.md) 的“打包与签名”里。

## 1. 版本和 tag 规则

- 正式 tag 是 `v<上游 X.Y.Z>-<fork A.B>`，如 `v0.1.11-1.7`。前一段是 fork 最近合入的上游 T3 Code 版本，后一段是 fork 自己的版本号，跨上游同步一直往上加。应用的版本号就是去掉 `v` 的 tag，由构建写进去，不用改 `package.json`。
- 新 tag 必须按 semver 比所有已发布的 tag 都大，两段都按数字比（`-1.10` 大于 `-1.9`）。`t3x update` 取 Releases 列表里**第一个**非草稿、渠道相同的 release，而列表按创建时间排序、不按版本，所以后发布的低版本会被当成最新。workflow 的 plan 任务会拒绝违反这条的 tag。上游那一段也要越过已发布的纯 `X.Y.Z`（`0.1.10-9.0` 小于 `0.1.10`）。
- `-nightly.`、`-preview.` 后缀是别的渠道，不要用。
- Android 的版本从 tag 算出来：`versionName` 是 `2.3.0-<A.B>`，`versionCode` 是 `A × 1000 + B`，只增不减，新 APK 能覆盖安装旧的。
- 测试构建用 `v0.0.0-ci.N`（或任何 `vX.Y.Z-ci.N`）。它们永远是草稿加 prerelease，没有任何客户端看得到。
- 已发布的 tag 不移动、不删除、不复用。发布出去的版本有问题，就发下一个版本号。

## 2. 打 tag 之前

1. 版本从 `main` 发。确认 `HEAD` 就是要发的提交，并且已经推送：`git status` 干净，`git fetch origin && git rev-parse HEAD origin/main` 两个 SHA 一样。
2. `vp run fork:guard` 通过。
3. 版本号没被占，并且比上一个已发布的大：`gh release list -R SimpleEve/t3-extend --limit 5`。一定要带 `-R`，裸的 `gh` 可能指向上游。
4. 如果上游那一段变了，同步已经合入，并记录在 `docs/fork/upstream.zh-CN.md`。

## 3. 写更新说明

每个版本都有 `docs/fork/changelog/<版本>.md`（版本号不带 `v`）。release 的正文就是这个文件，加上一小段下载列表。

**写哪些内容。** 写用户会拿到、但还没被告知过的所有变化：从**上一个写了更新说明的版本**算起，而不是只从上一个 tag 算起。没写更新说明就发出去的版本不算起点，它的变化要写进下一版。起点不是上一个版本时，在两段开头各用一句话说明（"下面列的是 0.1.11-1.0 以来的全部变化"）。

1. 起草：`vp run fork:changelog --version <版本>`。它在比 `<版本>` 小的 fork tag 里，找最高的、在 `docs/fork/changelog/` 里有文件的那个（一个都没有就用最早的 fork tag），读这之后的 first-parent 历史，把英文条目写进 `## English`，在 `## 中文` 里给每条放一个 `TODO(zh)` 占位。它会打印起点 tag，要核对。已有的文件不会被覆盖。上游同步合成一条。
2. 查有没有漏。运行 `git log --first-parent --format='%h %s' <起点 tag>..HEAD`，逐条看每个 `Merge branch …` 和 `feat`：要么写进了更新说明，要么是用户感知不到、有意不写。新的设置页、provider 能力、客户端界面、安装包格式一定要写。
3. 两段都手写一遍，按用户能感知到的事情一件一条，不是一个提交一条：
   - 写用户现在能做什么、什么问题不再出现、在哪里找到（设置路径、菜单）。不写提交标题、分支名和内部实现。
   - 同一个功能后续的修复和打磨并进它那一条。翻译修复合成一条。
   - 测试、文档、重构、CI、格式化、合并修补都不写。
   - 重要的放前面。条目多时把功能名加粗。
   - 按 新功能/Features、修复/Fixes、上游同步/Upstream、其他/Other 分组（空组不写）。上游那一条写明同步到的上游提交或版本，以及用户能看到的变化。
   - 两种语言条目相同、顺序相同。中文按中文的说法写，不逐词对译。
4. 去掉所有 `TODO`。已发布 tag 对应的文件不存在、含 `TODO`、或缺 `## 中文` / `## English` 任何一段时，workflow 都会拒绝。
5. 安装需要手动操作时要写出来，比如旧版本没法自更新。
6. 把文件提交到 `main` 并推送 `main`。

桌面版的更新弹窗只显示与应用语言一致的那一段（中文显示 `## 中文`，其他语言显示 `## English`），所以每一段都要自成一体。后面的 `## ` 标题下的内容（比如下载列表）不会显示。

已发布版本的更新说明写错或漏了：在 `main` 上改好文件，再把 release 正文换成它加上原来的下载列表：`gh release edit v<版本> -R SimpleEve/t3-extend --notes-file <文件>`。不要重打 tag。

## 4. 打 tag 并推送

```bash
git tag -a v<版本> -m "T3 Extend <版本>"
git push origin v<版本>
```

只推这一个 tag，不要用 `git push --tags`。tag 必须指向带更新说明文件的那个提交。

## 5. workflow 做什么

`plan` 任务读 tag，按第 1 节检查规则，并在任何长构建之前检查更新说明。然后并行构建：JS bundle 和三个 `t3x` 归档、签名的 macOS DMG 和更新 zip、Windows 安装包、Android APK。`release` 任务下载全部产物，检查 `latest-mac.yml` 和 `latest.yml` 点名的文件存在，摘要和大小对得上，写出 release 正文，先建成带齐所有产物的草稿，最后才发布成 latest release。没构建完的版本不会被看到。同一时刻只跑一个发布，后面的排队。

看进度：

```bash
gh run list -R SimpleEve/t3-extend --workflow fork-release.yml --limit 3
gh run watch <run-id> -R SimpleEve/t3-extend --exit-status
```

## 6. 发布之后

1. `gh release view v<版本> -R SimpleEve/t3-extend --json isDraft,isPrerelease,assets --jq '{isDraft,isPrerelease,assets:[.assets[].name]}'`。它不能是草稿或 prerelease，并且要有：
   - `T3-Extend-<版本>-arm64.dmg`、`.dmg.sha256`、`T3-Extend-<版本>-arm64.zip`、`latest-mac.yml`
   - `T3-Extend-<版本>-x64.exe`、`.exe.sha256`、`.exe.blockmap`、`latest.yml`
   - `T3-Extend-<应用版本>-arm64-v8a.apk`、`.apk.sha256`
   - `t3-<版本>-darwin-arm64.tar.gz`、`…-linux-x64.tar.gz`、`…-linux-arm64.tar.gz`、`SHA256SUMS`
2. 打开 release 页面。正文里有 `## 中文`、`## English` 和 `## 下载 / Downloads`，没有 `TODO`。
3. 确认它被标成 **Latest**：桌面版的更新器读的是 GitHub 的 latest release。
4. 在装着上一个版本的机器上（那个版本必须已经带更新器）打开应用，选 **Check for Updates…**。它要提示新版本，更新说明跟随应用语言。装上之后确认应用以新版本启动。第一个能自更新的版本是 0.1.11-1.7，所以第一次真实检查是 0.1.11-1.7 更新到下一个版本。
5. 用 DMG 或安装包全新安装一次，冒烟看一眼。

桌面版更新是怎么工作的，更新不起作用时看这里：

- 应用里有 `app-update.yml`，构建时由 `T3CODE_DESKTOP_UPDATE_REPOSITORY` 写入（workflow 每次运行都把它设成 `SimpleEve/t3-extend`，所以测试构建也带 feed；本机打包不手动设就没有）。没有这个变量的构建没有 feed，也没有 **Check for Updates…**。
- 它向 GitHub 要 latest release，从里面读 `latest-mac.yml` 或 `latest.yml`，按 semver 更高才提示。草稿、prerelease 和测试构建永远不是 latest release。
- macOS：Squirrel.Mac 只安装签名满足当前运行应用要求的更新。两者来自同一个自签名身份，所以 workflow 会检查 `EXPECTED_MAC_CERT_SHA1`。换了证书签的版本没法更新已有的安装，用户要手动装。
- Windows：安装包没签名，`app-update.yml` 里没有 `publisherName`，所以更新器只检查 `latest.yml` 里的 SHA-512。
- 0.1.11-1.6 及更早的安装没有更新器，要手动装一次 0.1.11-1.7。

## 7. 测试构建

不发布，只试流水线：

```bash
git tag v0.0.0-ci.1 && git push origin v0.0.0-ci.1
# 或者从某个分支触发（用的是该分支上的 workflow 文件）：
gh workflow run fork-release.yml -R SimpleEve/t3-extend --ref <分支> -f version=0.0.0-ci.1
```

`workflow_dispatch` 只接受 `-ci.N`，留空就是 `0.0.0-ci.<运行编号>`。测试构建有 `docs/fork/changelog/<版本>.md` 就用它，没有就现场起一份草稿，最后是草稿加 prerelease。测试构建出来的应用和正式版一样带更新 feed，检查的是真正的 latest release；草稿永远不会被提示，所以无害，还能用测试构建试更新器。用完清理：

```bash
gh release delete v0.0.0-ci.1 -R SimpleEve/t3-extend --yes --cleanup-tag
git tag -d v0.0.0-ci.1
```

## 8. 构建失败了怎么办

- 先看失败任务的日志。
- 偶发失败（runner、网络、下载抖动）：`gh run rerun <run-id> -R SimpleEve/t3-extend --failed`。重跑会删掉自己没发完的草稿，再建一个新的；已发布的 tag 它会拒绝。
- 需要改代码的失败：重跑构建的是 tag 指向的那个提交，修复带不进去。如果这个 tag 下从没发布过东西，就把 tag 挪过去：删远端 tag（`git push origin :refs/tags/v<版本>`）和本地 tag（`git tag -d v<版本>`），有草稿 release 就一并删掉，把修复（和变了的更新说明）提交到 `main`，再打 tag、推送。
- 已发布的版本绝不重打 tag。发布出去的版本有问题就发下一个版本号。想让客户端先别再看到它，把它改回草稿：`gh release edit v<版本> -R SimpleEve/t3-extend --draft`，`t3x update` 和桌面更新器都会跳过。
