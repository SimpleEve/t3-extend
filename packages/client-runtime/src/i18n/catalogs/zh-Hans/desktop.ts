// Electron main process: the application menu and native dialogs.
// Menu names follow macOS's own Simplified Chinese where one exists.
export default {
  // Application menu
  "About {name}": "关于 {name}",
  "Check for Updates...": "检查更新…",
  "Settings...": "设置…",
  Services: "服务",
  "Hide Others": "隐藏其他",
  "Show All": "全部显示",
  Quit: "退出",
  File: "文件",
  "Close Window": "关闭窗口",
  Edit: "编辑",
  Undo: "撤销",
  Redo: "重做",
  Cut: "剪切",
  Paste: "粘贴",
  "Paste as Text": "粘贴为纯文本",
  "Select All": "全选",
  Speech: "语音",
  "Start Speaking": "开始朗读",
  "Stop Speaking": "停止朗读",
  View: "查看",
  Reload: "重新加载",
  "Force Reload": "强制重新加载",
  "Toggle Developer Tools": "切换开发者工具",
  "Actual Size": "实际大小",
  "Zoom In": "放大",
  "Zoom Out": "缩小",
  "Toggle Full Screen": "切换全屏",
  Window: "窗口",
  Minimize: "最小化",
  Zoom: "缩放",
  "Bring All to Front": "前置全部窗口",
  Help: "帮助",

  // Update dialogs
  "You're up to date!": "已是最新版本！",
  "T3 Extend {version} is currently the newest version available.":
    "T3 Extend {version} 已是最新版本。",
  "Update check failed": "检查更新失败",
  "Could not check for updates.": "无法检查更新。",
  "An unknown error occurred. Please try again later.": "发生未知错误，请稍后重试。",
  "Updates unavailable": "更新不可用",
  "Automatic updates are not available right now.": "目前无法自动更新。",

  // In-app browser prompts
  "Open this {protocol} link?": "要打开此 {protocol} 链接吗？",
  "A page in the browser wants to open another application:\n\n{url}":
    "浏览器中的页面想打开另一个应用：\n\n{url}",
  Allow: "允许",
  Block: "阻止",
  "{origin} wants to see text and images copied to the clipboard":
    "{origin} 想查看复制到剪贴板的文字和图片",
  "Choose a passkey": "选择通行密钥",
  "Unnamed passkey": "未命名通行密钥",

  // Startup errors
  "T3 Extend failed to start": "T3 Extend 启动失败",
  "WSL backend is still unavailable": "WSL 后端仍不可用",
  "{reason}\n\nT3 Extend will use the Windows backend for this launch and retry WSL the next time the app starts.":
    "{reason}\n\nT3 Extend 本次启动将使用 Windows 后端，下次启动应用时会重试 WSL。",
  "WSL backend couldn't start": "WSL 后端无法启动",
  "{reason}\n\nFalling back to the Windows backend so T3 Extend can open. Re-enable the WSL backend from Settings > Sharing & access once the WSL distro is fixed.":
    "{reason}\n\n已改用 Windows 后端，以便 T3 Extend 能够打开。修复 WSL 发行版后，可在“设置 > 共享与访问”中重新启用 WSL 后端。",
  "This T3 home is unavailable": "此 T3 主目录不可用",

  "You're running T3 Extend {version}.": "你当前运行的是 T3 Extend {version}。",
  "Update downloading": "正在下载更新",
  "T3 Extend will restart to install it. Any running tasks will be interrupted.":
    "T3 Extend 将重启以安装更新，正在运行的任务会被中断。",
  "Close Developer Tools": "关闭开发者工具",
} satisfies Record<string, string>;
