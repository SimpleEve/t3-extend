// Sidebar footer status chips (apps/web/src/fork/): subscription limits, resources, ports, power,
// and the background service switch.
export default {
  "Sidebar status": "侧边栏状态",
  "Subscription limits": "订阅额度",
  "Show how much of each provider's subscription window is left.":
    "显示各 provider 订阅窗口还剩多少。",
  "Usage details": "用量详情",
  "Resource usage": "资源占用",
  Power: "电源",
  "Show the CPU and memory T3 uses on the shown computer.":
    "显示 T3 在当前所示电脑上占用的 CPU 和内存。",
  "Show the local servers that threads of the shown projects started.":
    "显示所示项目的对话启动的本地服务。",
  "Open in preview": "在预览中打开",
  "Keep computer awake while agents work": "Agent 工作时保持电脑唤醒",
  "Keeps this computer from sleeping on idle while a thread on it is running. The screen can still turn off. Whether closing the lid puts it to sleep is up to macOS, and this switch cannot change that.":
    "本机有对话在运行时，不让电脑因闲置而睡眠，屏幕仍可以熄灭。合上盖子后睡不睡仍由 macOS 决定，这个开关管不到。",
  "Background running": "后台运行",
  "Keep running in the background": "在后台保持运行",
  "Keeps T3 Extend running after you quit the app, so your phone stays connected and notifications keep arriving. The app stops it while the app is open and starts it again when you quit.":
    "退出 App 后让 T3 Extend 继续运行，手机保持连接，推送不中断。App 打开时由 App 自己的服务器接管，后台服务会先停下，退出后再自动启动。",
  "Off. Quitting the app also stops T3 Extend.": "已关闭。退出 App 后 T3 Extend 也会停止。",
  "On. T3 Extend keeps running after you quit the app.": "已开启。退出 App 后 T3 Extend 继续运行。",
  "The app this runs from was moved or deleted. Turn this off, then on again from the app's current location.":
    "后台服务所在的 App 被移动或删除了。先关闭，再从 App 现在所在的位置重新开启。",
  "Set up by another version of the app. Repair it so it runs this version.":
    "后台服务是由另一个版本的 App 设置的。修复后会改为运行当前版本。",
  "A background service for another data folder is already installed on this computer. Remove it from a terminal first.":
    "这台电脑上已经安装了另一个数据目录的后台服务。请先在终端里移除它。",
  "Could not read the background service's state.": "无法读取后台服务的状态。",
  "Could not change it: {error}": "没能完成：{error}",
  Repair: "修复",
  Retry: "重试",
  "The background service did not start when you last quit: {reason}":
    "上次退出时后台服务没能启动：{reason}",
  "The background service did not start": "后台服务没能启动",
  "It could not start when you last quit, so T3 Extend stopped with the app. Open Settings, General to retry. {reason}":
    "上次退出时它没能启动，T3 Extend 随 App 一起停了。请打开设置，通用，点重试。{reason}",
  "The background service did not stop": "后台服务没能停下",
  "T3 Extend's background service is still running, so the app cannot start its own server on the same data folder.\n\n{reason}\n\nRun `{command} service uninstall` in a terminal to remove the background service, then open T3 Extend again.":
    "T3 Extend 的后台服务还在运行，App 没法在同一个数据目录上再起自己的服务器。\n\n{reason}\n\n请在终端里运行 `{command} service uninstall` 移除后台服务，然后重新打开 T3 Extend。",
};
