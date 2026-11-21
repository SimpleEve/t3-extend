# 术语表与翻译规则

T3 Extend 的界面译文都按这里翻译。改某一条时，在下面"改动记录"里写明理由，并同步改掉 catalog 里已有的译文。

## 用法

- 英文原文就是 key：`t("Archive thread")`。catalog 里没有的英文原样显示，所以上游改了文案只会暂时变回英文。
- 插值写作 `{name}`，译文必须保留同一组占位符（有测试检查）。
- 同一个英文在不同语境要不同译法时，才用带 context 的 key：调用写 `t("Active", undefined, "sidebar section")`，catalog 写 `"sidebar section|Active": "进行中"`。尽量少用。
- catalog 按界面分文件放在 `catalogs/zh-Hans/<area>.ts`。同一个 key 出现在两个文件里时译文必须一致（有测试检查），通用词放 `common.ts`。
- 不能在模块顶层调用 `translate()` 或 `t()`：那时保存的语言还没读出来，结果会永远是英文。模块级常量保存英文原文，渲染时再翻译；非 React 代码用 `translate(getUiLocale(), ...)`，在显示的那一刻读取语言。

## 不翻译

- 用户内容：对话标题（占位标题 "New thread" 例外，只在显示时经 `threadDisplayTitle` 翻译）、项目名、路径、分支、模型名、provider 名、主题名、Agent 输出。
- 面向模型的文案：MCP 工具描述、agent instructions、`evals/` 覆盖的文本。
- server 返回的错误信息（以后在客户端按 tag 映射）。
- 日志、产品名（T3 Code、T3 Connect）、快捷键名。

## 术语

| 英文                     | 中文                   | 说明                                                                                                 |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| thread                   | 对话                   |                                                                                                      |
| session（登录会话）      | 会话                   | Agent session 也译"会话"                                                                             |
| project                  | 项目                   |                                                                                                      |
| worktree                 | worktree               | 不译                                                                                                 |
| main checkout            | 主 checkout            | 项目的原始目录，和 linked worktree 相对                                                              |
| Main（worktree 徽标）    | 主                     | 按项目视图里主 checkout 子组的标记                                                                   |
| branch                   | 分支                   |                                                                                                      |
| commit                   | 提交                   |                                                                                                      |
| PR / pull request        | PR                     | 按钮里的 "pull requests" 也写 PR                                                                     |
| agent                    | Agent                  |                                                                                                      |
| provider                 | provider               | 不译；设置导航里的分区名写 Provider                                                                  |
| environment              | 环境                   |                                                                                                      |
| turn                     | 轮次                   |                                                                                                      |
| checkpoint               | 检查点                 |                                                                                                      |
| Pin / Pinned             | 置顶 / 已置顶          |                                                                                                      |
| Unpin                    | 取消置顶               |                                                                                                      |
| Snooze / Snoozed         | 稍后处理               | 动作和分区同名                                                                                       |
| Wake / Woke              | 唤醒 / 已唤醒          | 让稍后处理的对话提前回来                                                                             |
| Settle / Settled         | 标为已处理 / 已处理    |                                                                                                      |
| Un-settle                | 移出已处理             |                                                                                                      |
| Auto-settle              | 自动标为已处理         |                                                                                                      |
| Working                  | 运行中                 | 对话状态和侧边栏分区                                                                                 |
| Active                   | 进行中                 | 侧边栏分区                                                                                           |
| Waiting / Done / Failed  | 等待中 / 已完成 / 失败 | 对话状态                                                                                             |
| Approval / Input         | 待批准 / 待输入        | 对话等你处理的状态                                                                                   |
| Settings                 | 设置                   |                                                                                                      |
| Appearance               | 外观                   |                                                                                                      |
| Sharing & access         | 共享与访问             |                                                                                                      |
| Archive                  | 归档                   |                                                                                                      |
| draft                    | 草稿                   |                                                                                                      |
| composer                 | 输入框                 | 用户写消息的区域                                                                                     |
| prompt                   | 提示词                 |                                                                                                      |
| diff                     | 差异                   |                                                                                                      |
| theme                    | 主题                   |                                                                                                      |
| Follow system / System   | 跟随系统               | 外观模式和语言选项                                                                                   |
| Copy                     | 复制                   | 菜单和按钮通用；"Duplicate theme" 也译复制主题                                                       |
| pairing code / token     | 配对码 / 配对令牌      | "Copy code" 有三种 context，见改动记录                                                               |
| token（模型）            | token                  | 上下文、用量里的 token 计数不译                                                                      |
| tunnel                   | 隧道                   |                                                                                                      |
| route                    | 路由                   |                                                                                                      |
| backend                  | 后端                   |                                                                                                      |
| host（机器）             | 主机                   | 见下文"host 的两种义项"                                                                              |
| host（源码托管方）       | 托管平台               | GitHub、GitLab 这类；PR 过滤用 `source control` context                                              |
| scope                    | 权限范围               |                                                                                                      |
| relay client             | 中继客户端             |                                                                                                      |
| credential               | 凭据                   |                                                                                                      |
| Live Activities          | 实时活动               |                                                                                                      |
| Review guide / guide     | 审查导读 / 导读        |                                                                                                      |
| SnapShots                | 快照                   | 跟上游 GT 的译法                                                                                     |
| Boring sidebar           | 朴素侧边栏             |                                                                                                      |
| Supervised               | 受监督                 | runtime mode                                                                                         |
| Auto-accept edits        | 自动接受编辑           | runtime mode                                                                                         |
| Auto                     | 自动                   | runtime mode                                                                                         |
| Full access              | 完全访问               | runtime mode                                                                                         |
| Working（按钮）          | 处理中                 | 按钮上的进行态用 `pending button` context；对话状态仍是"运行中"                                      |
| steer                    | 引导                   |                                                                                                      |
| queue                    | 加入队列               | 动作跟上游 GT；已排队的状态写"排队中"                                                                |
| stash（输入框）          | 暂存 / 暂存区          | git 的 stash 不译                                                                                    |
| side chat                | 侧边对话               |                                                                                                      |
| compact                  | 压缩                   |                                                                                                      |
| handoff                  | 交接                   |                                                                                                      |
| fork（对话）             | 分叉                   | git 的 fork 不在这个义项里                                                                           |
| subagent                 | 子 Agent               |                                                                                                      |
| checks                   | 检查                   |                                                                                                      |
| review                   | 审查                   | 更新通道里的 "Review" 用 `update channel` context 译"查看"                                           |
| Write                    | 编辑                   | PR 编辑器的标签页；磁盘 IO 用 `disk io` context 译"写入"                                             |
| stack                    | 堆叠                   |                                                                                                      |
| check out                | 检出                   |                                                                                                      |
| push / pull              | 推送 / 拉取            |                                                                                                      |
| rebase / merge / remote  | 不译                   | 按钮上的 "Merge" 动作译"合并"                                                                        |
| MR / change request      | MR / 变更请求          | PR 和 MR 原样保留                                                                                    |
| mention                  | 提及                   | 跟上游 GT                                                                                            |
| cite / citation          | 引用                   | 跟上游 GT                                                                                            |
| annotation               | 标注                   |                                                                                                      |
| Plan / Build（交互模式） | 计划 / 构建            | 用 `interaction mode` context；设置里的 "Plan" 指套餐                                                |
| server                   | 服务器                 | 中文句子里都写"服务器"，如"T3 Code 服务器"；命令和代码标识符不改                                     |
| limits                   | 上限                   | 用量、速率这类限额都写"上限"                                                                         |
| triage                   | 排查                   |                                                                                                      |
| detached HEAD            | 分离的 HEAD            |                                                                                                      |
| Open / Closed / Merged   | 开放 / 已关闭 / 已合并 | PR 状态，用 `pull request state` context；小写形式也建 key                                           |
| Reopen                   | 重新打开               | 动作                                                                                                 |
| setup（脚本角色）        | 创建 worktree 时       | 脚本菜单和徽标里的角色，用 `script role` context；和 "on settle"（标为已处理时）并列，都是“何时运行” |
| Lint                     | Lint                   | 开发术语，脚本图标名保留英文（`script icon` context）                                                |

## host 的两种义项

- 运行 T3 Code server、设备或模拟器的机器：译"主机"。例：设备主机、主机诊断、Simlock 主机、可访问的主机。
- GitHub、GitLab 这类源码托管方：译"托管平台"。例：PR 页的托管平台过滤、"正在等待托管平台状态"、"托管平台会自动合并"。
- 拿不准时看句子里的 host 能不能换成 GitHub：能就是托管平台。两种义项的英文 key 相同时（如 `Host`），给托管平台那一处加 `source control` context。

## 拼出来的短语

- 工具调用摘要、计数短语这类由代码拼接的文案，按整句建 key（`Ran {count} commands`），不要只翻动词或名词，中文语序不同。
- 共享的纯函数（client-runtime、shared）接受一个可选的翻译函数，不传时英文逐字不变，mobile 依赖这一点。web 传入当前语言的 `t`。
- 列表连接词也走 catalog：`{first} and {second}`、`{rest}, and {last}`、`, `。工具摘要用 `tool summary` context，中文以逗号连接。

## 标点与格式

- 不用破折号 `——`：仓库的 `no-em-dash-copy` lint 规则拒绝 U+2014。改用逗号、冒号或括号。
- 中文标点用全角：，。：；？！（）“”。省略号沿用原文的 `…`。
- 中文与英文、数字之间加一个空格：`5 分钟前`、`在 {branch} 上新建对话`。
- 用"你"，不用"您"。

## 改动记录

- `Snooze` 的动作和 `Snoozed` 分区都译"稍后处理"，与起始表一致；唤醒类动作单独用"唤醒"。
- `Un-settle` 起始表没有给出，译"移出已处理"，和"标为已处理"成对。
- `main checkout` 译"主 checkout"：checkout 和 worktree 一样不译，"主"和 linked worktree 区分开。徽标只写"主"。
- 撤销提示的短格式（`Settled`、`Snoozed {count}` 等）带 `undo notice` context，避免和分区名、状态名共用同一个 key。
- 合入 P6-A、P6-B 提出的术语（见上表）。
- `Queue` 原来有"排队"和"排队发送"两种：统一为"排队发送"，设置页的跟进方式选项随之改掉；"排队的消息""排队中"保留，因为它们是状态而非动作。
- `host` 原来混用"主机"和"托管平台"：按上文"host 的两种义项"区分，PR 页过滤器的 `Host` 改用 `source control` context。
- `Check out` 统一为"检出"，git 操作里的"切换到功能分支并继续"改为"检出功能分支并继续"。
- `SnapShots` 是功能名，设置导航里原来译成"截图"，改回 SnapShots。
- `Copy code` 拆成三种 context：默认（配对码）、`device code`（设备码）、`code block`（代码块）。Mermaid 的 "Show code" 用 `diagram source` context 译"显示源码"，因为连接页的 "Show code" 是配对码。
- `Plan` 在设置里指套餐，计划卡片和交互模式分别用 `proposed plan`、`interaction mode` context 译"计划"。
- `Plain text` 在设置里指明文（和"敏感"相对），代码块语言选择器用 `code language` context 译"纯文本"。
- 限额类原来混用"上限"和"限额"：统一为"上限"。
- 句子里原来夹着英文 `server`：统一为"服务器"。
- 脚本角色 `setup` 原来是裸 key，译"设置"，和 Settings 混在一起；改用 `script role` context 译"创建 worktree 时"，与 `on settle`（标为已处理时）并列，都是"何时运行"。
- 2026-11-21：除上面已定的 fork 术语（thread、Agent、provider、worktree、side chat、snooze、settle、review guide、route、usage limits）外，译文一律跟上游 GT 的 zh。mention、cite、queue、SnapShots 改为上游的提及、引用、加入队列、快照；fork 目录里和上游同一句英文的译文也换成了上游的写法。
