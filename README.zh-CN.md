# T3 Extend

[English](./README.md) | 简体中文

T3 Extend 是 [T3 Code](https://github.com/pingdotgg/t3code) 的独立 fork。它在上游的基础上加了中文界面、自建连接、Android 上不依赖 Google 的推送等能力，并且可以和官方 T3 Code 装在同一台电脑上同时运行，两边的数据、命令、端口和服务互不干扰。

> T3 Extend 与 T3 Tools Inc. 没有隶属、背书或赞助关系。"T3 Code" 只用来说明它的来源，见 [NOTICE](./NOTICE)。

## 对应的上游版本

当前合入到上游提交 [`55c134a346`](https://github.com/pingdotgg/t3code/commit/55c134a346d5830399c82e647f29101fec22ecee)（2026-11-16），在上游 nightly `v0.1.11-nightly.20261117.4814` 之后第 28 个提交。T3 Extend 桌面版和 server 的版本是 0.1.10，Android 应用是 2.3.0。

上游这个版本的能力，T3 Extend 基本都有。主要差别如下。

**fork 额外加的：**

- 中文界面（web、桌面、Android），可以选英文、简体中文或跟随系统
- 侧栏按项目分组，侧栏底部有额度、资源和端口状态，桌面版可以保持唤醒
- 自建连接：用自己的 VPS 代替 T3 Connect，让手机和别的电脑连回来
- 在桌面版里，可以直接用 `localhost` 打开远程环境上的开发服务；手机上可以新建浏览器标签页
- Android 推送走 UnifiedPush 和自建 ntfy，不经过 Google
- macOS 桌面版可以在后台运行，退出 app 后服务继续工作
- 每轮回复列出产出的文件和链接；输入框旁显示上下文用量和输出速度
- omp provider、Codex 自定义端点下读取额度、Antigravity 沿用 `agy` 的登录
- 从本机的官方 T3 Code 只读导入项目、对话和设置
- telemetry 默认关闭

**在 fork 里用不了的：** T3 Connect、guest link、passkey、桌面自动更新、移动端 OTA、iOS 应用、官方的安装脚本和应用商店渠道。

完整的能力列表、取舍原因和同步历史见 [上游版本与 fork 能力](./docs/fork/upstream.zh-CN.md)。

## 安装

T3 Extend 目前没有发布安装包，需要从源码构建：

- macOS（Apple silicon）：`vp run fork:dist:mac`，生成 `T3-Extend-<version>-arm64.dmg`。安装和第一次启动的步骤见 [install.md](./docs/user/install.md#t3-extend-on-macos)。
- Android：`vp run fork:dist:android`，生成 APK。
- 构建环境和签名见 [FORK.md 的打包与签名](./FORK.md#打包与签名)，第一次检出源码的步骤见 [开发手册](./docs/operations/development.md#first-checkout)。

T3 Extend 的命令行叫 `t3x`，数据目录在 `~/.t3extend`，默认端口是 3873。官方 T3 Code 用的是 `t3`、`~/.t3` 和 3773，两边不冲突。

## 让手机和别的电脑连上来

T3 Extend 支持局域网配对、Tailscale（HTTPS 端口 8443）、自建服务器和 SSH。怎么选、怎么搭、怎么撤销访问，见 [搭建 server 与配置访问](./docs/fork/server-setup.zh-CN.md)。自建服务器的 VPS 部署见 [infra/self-host](./infra/self-host/README.md)。

## 文档

- [上游版本与 fork 能力](./docs/fork/upstream.zh-CN.md)
- [搭建 server 与配置访问](./docs/fork/server-setup.zh-CN.md)
- [FORK.md](./FORK.md)：fork 的身份、共存规则、各项功能的设计和同步上游的流程
- [上游文档](./docs/README.md)：沿用上游的用户文档，fork 改过的地方有标注；文中的 `t3` 在 T3 Extend 里换成 `t3x`

## 参与开发

- 先读 [FORK.md](./FORK.md) 和 [AGENTS.md](./AGENTS.md)。fork 改动上游文件的行都带 `// fork:` 注释，提交前要通过 `vp run fork:guard`。
- 上游本身的问题，请到 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 反馈。

## 许可证

[MIT](./LICENSE)。上游 T3 Code 的版权归 T3 Tools Inc.，fork 的改动采用同样的许可证。随构建打包的第三方组件及其许可证见 [NOTICE](./NOTICE)。
