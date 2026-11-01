// Command palette: group headings and fixed command names. Titles that are user content
// (threads, projects, branches) are never translated.
export default {
  // Group headings
  Suggestions: "建议",
  "In messages": "消息中",
  Directories: "目录",
  Actions: "操作",
  "Recent Threads": "最近的对话",
  Sources: "来源",
  Options: "选项",
  "Select where to clone": "选择克隆位置",
  "Change theme": "更换主题",
  "Change appearance": "更换外观",
  Current: "当前",
  "No matching actions.": "没有匹配的操作。",
  "No matching commands, projects, or threads.": "没有匹配的命令、项目或对话。",

  // Commands
  "New thread in...": "在指定项目中新建对话…",
  "New thread without a project": "新建不属于项目的对话",
  "Triage an issue": "排查问题",
  "An agent investigates a T3 Code problem and helps file an issue":
    "由 Agent 排查 T3 Code 的问题并协助提交 issue",
  "Find in current thread": "在当前对话中查找",
  "Copy prompt link": "复制提示词链接",
  "Copy prompt link with repo and model": "复制带仓库和模型的提示词链接",
  "Copy PR link": "复制 PR 链接",
  "Copy thread": "复制对话",
  "Link pull request to thread": "将 PR 关联到对话",
  "Show linked pull requests": "显示关联的 PR",
  "Restart agent session": "重启 Agent 会话",
  "Go to file": "转到文件",
  "Search project contents": "搜索项目内容",
  "Open WSL folder": "打开 WSL 文件夹",
  "Open pull requests": "打开 PR 列表",
  "Open usage": "打开用量",
  "Open settings": "打开设置",
  "Pin project": "置顶项目",
  "Unpin project": "取消置顶项目",
  "Focus Next Workspace Area": "聚焦下一个工作区域",
  "Focus Previous Workspace Area": "聚焦上一个工作区域",
  // fork: sidebar views
  "Sidebar: Group by status": "侧边栏：按状态",
  "Sidebar: Group by project": "侧边栏：按项目",

  // Search field placeholders
  "Search commands, projects, and threads...": "搜索命令、项目和对话…",
  "Search...": "搜索…",
  "Enter project path (e.g. ~/projects/my-app)": "输入项目路径（例如 ~/projects/my-app）",
  "Enter path (e.g. ~/projects/my-app)": "输入路径（例如 ~/projects/my-app）",

  // Footer hints; key names (Enter, Esc) stay as they are.
  Navigate: "导航",
  Select: "选择",
  "Searching messages…": "正在搜索消息…",
  "Command palette": "命令面板",
  "Toggle theme editor": "切换主题编辑器",
} satisfies Record<string, string>;
