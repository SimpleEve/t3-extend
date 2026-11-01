// Settings → Sharing & access: the fork's self-hosted connection rows.
export default {
  "Public addresses": "自定义公网地址",
  "HTTPS addresses that reach this computer through your own server, such as a reverse tunnel on a VPS. Devices you pair learn them and use them when they are away from your network.":
    "经过你自己的服务器访问这台电脑的 HTTPS 地址，例如 VPS 上的反向隧道。配对过的设备会自动学到这些地址，离开家里的网络后改走它们。",
  "Set by environment": "由环境变量设置",
  "Remove {address}": "删除 {address}",
  "New public address": "新的公网地址",
  "Enter an HTTPS address with no path, such as https://t3.example.com.":
    "请输入不带路径的 HTTPS 地址，例如 https://t3.example.com。",
  "Could not save public addresses": "无法保存公网地址",
  Add: "添加",

  "Tunnel command": "隧道命令",
  "Optional. T3 Extend runs this command while the app is open, restarts it if it exits, and stops it when you quit. It runs on this computer as you, for example frpc -c ~/frpc.toml.":
    "可选。应用打开期间 T3 Extend 会运行这条命令，退出后自动重启，退出应用时停止。它以你的身份在这台电脑上运行，例如 frpc -c ~/frpc.toml。",
  "Run tunnel command": "运行隧道命令",
  Save: "保存",
  Restart: "重启",
  "Recent output": "最近输出",
  "Restarted {count} times": "已重启 {count} 次",
  Stopped: "已停止",
  Starting: "启动中",
  Running: "运行中",
  Restarting: "正在重启",
  "Could not update the tunnel": "无法更新隧道",
  "Could not restart the tunnel": "无法重启隧道",
  "Could not start the command.": "无法启动命令。",
  "The command exited with code {code}.": "命令已退出，退出码 {code}。",
  "The command was stopped by {signal}.": "命令被信号 {signal} 终止。",
};
