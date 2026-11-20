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
  View: "视图",
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
  "You're up to date!": "已是最新版本",
  "T3 Extend {version} is currently the newest version available.":
    "T3 Extend {version} 是目前可用的最新版本。",
  "Update check failed": "检查更新失败",
  "Could not check for updates.": "无法检查更新。",
  "An unknown error occurred. Please try again later.": "发生未知错误，请稍后重试。",
  "Updates unavailable": "无法更新",
  "Automatic updates are not available right now.": "目前无法使用自动更新。",

  // In-app browser prompts
  "Open this {protocol} link?": "打开这个 {protocol} 链接？",
  "A page in the browser wants to open another application:\n\n{url}":
    "浏览器中的页面想要打开另一个应用：\n\n{url}",
  Allow: "允许",
  Block: "阻止",
  "{origin} wants to see text and images copied to the clipboard":
    "{origin} 想要读取剪贴板中复制的文字和图片",
  "Choose a passkey": "选择通行密钥",
  "Unnamed passkey": "未命名的通行密钥",

  // Startup errors
  "T3 Extend failed to start": "T3 Extend 启动失败",
  "WSL backend is still unavailable": "WSL 后端仍不可用",
  "{reason}\n\nT3 Extend will use the Windows backend for this launch and retry WSL the next time the app starts.":
    "{reason}\n\nT3 Extend 本次启动将使用 Windows 后端，下次启动应用时会重试 WSL。",
  "WSL backend couldn't start": "WSL 后端无法启动",
  "{reason}\n\nFalling back to the Windows backend so T3 Extend can open. Re-enable the WSL backend from Settings > Sharing & access once the WSL distro is fixed.":
    "{reason}\n\n已改用 Windows 后端，以便 T3 Extend 能够打开。修复 WSL 发行版后，可在“设置 > 共享与访问”中重新启用 WSL 后端。",
  "This T3 home is unavailable": "这个 T3 数据目录不可用",

  // Page shown when a remote environment's localhost cannot be forwarded
  "Can't forward localhost:{port}": "无法转发 localhost:{port}",
  "This port was not started by a terminal or agent in T3 on the remote environment, or the service has detached from the terminal or agent that started it (for example, moved to the background with nohup). Start it from a T3 terminal.":
    "这个端口上的服务不是由远程环境里 T3 的终端或 Agent 启动的，或者它已经脱离了启动它的终端或 Agent（例如用 nohup 放到了后台）。请改在 T3 的终端里启动它。",
  "This port can't be forwarded.": "此端口无法转发。",
  "This service is running with debugging turned on, so it can't be forwarded.":
    "此服务带着调试参数运行，无法转发。",
  "The service on this port just changed. Reload to try again.":
    "此端口上的服务刚刚变了。请重新加载再试。",
  "Nothing is listening on this port in the remote environment. Start the service, then reload.":
    "远程环境里没有程序在监听此端口。请先启动服务，再重新加载。",
  "This service doesn't listen on localhost. It only listens on another address, which localhost can't reach. Make it listen on 127.0.0.1 as well.":
    "这个服务没有监听 localhost，只监听了别的地址，经 localhost 转发不到。请让它同时监听 127.0.0.1。",
  "The remote environment can't be reached.": "连不上远程环境。",
  "This connection is not allowed to forward ports.": "此连接没有转发端口的权限。",
  "Reconnecting to the remote environment...": "正在重新连接远程环境…",
  "The remote environment's T3 version can't forward localhost.":
    "远程环境的 T3 版本不支持转发 localhost。",
  "This computer does not trust the remote environment's certificate.":
    "这台电脑不信任远程环境的证书。",
  "Too many forwarded connections. Reload to try again.": "转发的连接太多。请重新加载再试。",
  "Forwarding failed ({code}).": "转发失败（{code}）。",
  "You're running T3 Extend {version}.": "你正在运行 T3 Extend {version}。",
  "Update downloading": "正在下载更新",
  "T3 Extend will restart to install it. Any running tasks will be interrupted.":
    "T3 Extend 将重启以安装更新，正在运行的任务会被中断。",
  "Close Developer Tools": "关闭开发者工具",
} satisfies Record<string, string>;
