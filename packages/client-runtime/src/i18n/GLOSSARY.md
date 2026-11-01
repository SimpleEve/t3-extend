# 术语表与翻译规则

T3 Extend 的界面译文都按这里翻译。改某一条时，在下面"改动记录"里写明理由，并同步改掉 catalog 里已有的译文。

## 用法

- 英文原文就是 key：`t("Archive thread")`。catalog 里没有的英文原样显示，所以上游改了文案只会暂时变回英文。
- 插值写作 `{name}`，译文必须保留同一组占位符（有测试检查）。
- 同一个英文在不同语境要不同译法时，才用带 context 的 key：调用写 `t("Active", undefined, "sidebar section")`，catalog 写 `"sidebar section|Active": "进行中"`。尽量少用。
- catalog 按界面分文件放在 `catalogs/zh-Hans/<area>.ts`。同一个 key 出现在两个文件里时译文必须一致（有测试检查），通用词放 `common.ts`。
- 不能在模块顶层调用 `translate()` 或 `t()`：那时保存的语言还没读出来，结果会永远是英文。模块级常量保存英文原文，渲染时再翻译；非 React 代码用 `translate(getUiLocale(), ...)`，在显示的那一刻读取语言。

## 不翻译

- 用户内容：对话标题、项目名、路径、分支、模型名、provider 名、主题名、Agent 输出。
- 面向模型的文案：MCP 工具描述、agent instructions、`evals/` 覆盖的文本。
- server 返回的错误信息（以后在客户端按 tag 映射）。
- 日志、产品名（T3 Code、T3 Connect）、快捷键名。

## 术语

| 英文                    | 中文                   | 说明                                           |
| ----------------------- | ---------------------- | ---------------------------------------------- |
| thread                  | 对话                   |                                                |
| session（登录会话）     | 会话                   | Agent session 也译"会话"                       |
| project                 | 项目                   |                                                |
| worktree                | worktree               | 不译                                           |
| branch                  | 分支                   |                                                |
| commit                  | 提交                   |                                                |
| PR / pull request       | PR                     | 按钮里的 "pull requests" 也写 PR               |
| agent                   | Agent                  |                                                |
| provider                | provider               | 不译；设置导航里的分区名写 Provider            |
| environment             | 环境                   |                                                |
| turn                    | 轮次                   |                                                |
| checkpoint              | 检查点                 |                                                |
| Pin / Pinned            | 置顶 / 已置顶          |                                                |
| Unpin                   | 取消置顶               |                                                |
| Snooze / Snoozed        | 稍后处理               | 动作和分区同名                                 |
| Wake / Woke             | 唤醒 / 已唤醒          | 让稍后处理的对话提前回来                       |
| Settle / Settled        | 标为已处理 / 已处理    |                                                |
| Un-settle               | 移出已处理             |                                                |
| Auto-settle             | 自动标为已处理         |                                                |
| Working                 | 运行中                 | 对话状态和侧边栏分区                           |
| Active                  | 进行中                 | 侧边栏分区                                     |
| Waiting / Done / Failed | 等待中 / 已完成 / 失败 | 对话状态                                       |
| Approval / Input        | 待批准 / 待输入        | 对话等你处理的状态                             |
| Settings                | 设置                   |                                                |
| Appearance              | 外观                   |                                                |
| Sharing & access        | 共享与访问             |                                                |
| Archive                 | 归档                   |                                                |
| draft                   | 草稿                   |                                                |
| composer                | 输入框                 | 用户写消息的区域                               |
| prompt                  | 提示词                 |                                                |
| diff                    | 差异                   |                                                |
| theme                   | 主题                   |                                                |
| Follow system / System  | 跟随系统               | 外观模式和语言选项                             |
| Copy                    | 复制                   | 菜单和按钮通用；"Duplicate theme" 也译复制主题 |

## 标点与格式

- 不用破折号 `——`：仓库的 `no-em-dash-copy` lint 规则拒绝 U+2014。改用逗号、冒号或括号。
- 中文标点用全角：，。：；？！（）“”。省略号沿用原文的 `…`。
- 中文与英文、数字之间加一个空格：`5 分钟前`、`在 {branch} 上新建对话`。
- 用"你"，不用"您"。

## 改动记录

- `Snooze` 的动作和 `Snoozed` 分区都译"稍后处理"，与起始表一致；唤醒类动作单独用"唤醒"。
- `Un-settle` 起始表没有给出，译"移出已处理"，和"标为已处理"成对。
