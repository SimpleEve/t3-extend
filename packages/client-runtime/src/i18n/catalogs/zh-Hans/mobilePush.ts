// Push notifications through the user's own server: UnifiedPush (Android) and APNs (iOS).
export default {
  "Push without Google": "不依赖 Google 的推送",
  "Delivered by your own push server through UnifiedPush, with no Google services.":
    "通过 UnifiedPush 由你自己的推送服务器送达，不使用 Google 服务。",
  "Set up a push app": "设置推送应用",
  "Install ntfy from F-Droid, open it and set its server to your own, then come back here.":
    "从 F-Droid 安装 ntfy，打开后把服务器设为你自己的，然后回到这里。",
  "Use this push app": "使用这个推送应用",
  "Push app": "推送应用",
  "Push server": "推送服务器",
  "Waiting for the push server…": "正在等待推送服务器…",
  "Open {app} once. If it keeps waiting, allow it to run in the background.":
    "打开一次 {app}；如果一直在等，请允许它在后台运行。",
  "Registration failed": "注册失败",
  Registered: "已注册",
  "Registering…": "正在注册…",
  "Waiting for the connection…": "正在等待连接…",
  "Not registered": "未注册",
  "Not registered: can't reach this environment": "未注册：连不上这个环境",
  "Not registered: this environment didn't answer": "未注册：这个环境没有响应",
  "Not registered: this connection can't register devices": "未注册：这个连接无权注册设备",
  "Not registered: this environment refused the registration": "未注册：这个环境拒绝了注册",
  "Not registered: this environment couldn't read the request": "未注册：这个环境无法读懂请求",
  "Send test notification": "发送测试通知",
  "Test notification sent": "测试通知已发送",
  "The push server accepted it. It should appear on this phone in a moment.":
    "推送服务器已接收，稍后应该会出现在这部手机上。",
  "Test notification failed": "测试通知失败",
  "Couldn't reach {environment}. Check the connection and try again.":
    "连不上 {environment}。请检查连接后重试。",
  "Not registered yet": "尚未注册",
  "{environment} has no registration for this phone yet. Try again in a moment.":
    "{environment} 还没有这部手机的注册信息。请稍后再试。",
  "Registration expired": "注册已失效",
  "The push server no longer knows this phone, so {environment} removed the registration. Turn push notifications off and on again.":
    "推送服务器已不认识这部手机，所以 {environment} 删除了注册。请把推送通知关掉再打开。",
  "Push server refused it": "推送服务器拒绝了它",
  "The push server answered with an error (HTTP {status}). Check that it accepts writes to topics starting with up.":
    "推送服务器返回了错误（HTTP {status}）。请检查它是否允许写入以 up 开头的主题。",
  "Push server unreachable": "连不上推送服务器",
  "{environment} couldn't reach the push server. Check the server's address and network.":
    "{environment} 连不上推送服务器。请检查服务器的地址和网络。",
  "Question for you": "需要你回答",
  "{app} test notification": "{app} 测试通知",
  "Notifications from {environment} reach this phone.": "{environment} 的通知能送达这部手机。",
  "Push notifications aren't supported in builds made with a free Apple account.":
    "用免费 Apple 账号构建的版本不支持推送通知。",
  "Sent from your own server straight to Apple's push service, with no relay.":
    "由你自己的服务器直接发给 Apple 推送服务，不经过中继。",
  "Notifications are turned off for this app in iOS Settings, so alerts won't show.":
    "这个应用的通知在 iOS 设置里已关闭，所以提醒不会显示。",
  "No push token": "没有推送令牌",
  "Apple didn't give this app a push token. This build may be missing the Push Notifications capability.":
    "Apple 没有给这个应用推送令牌。这个版本可能缺少推送通知（Push Notifications）能力。",
  "Not registered: this server has no APNs key": "未注册：这台服务器没有配置 APNs 密钥",
  "Set the T3EXTEND_APNS_* variables on that server and restart it.":
    "请在那台服务器上设置 T3EXTEND_APNS_* 环境变量，然后重启它。",
  "Apple accepted it. It should appear on this phone in a moment.":
    "Apple 已接收，稍后应该会出现在这部手机上。",
  "Apple no longer knows this phone, so {environment} removed the registration. Turn push notifications off and on again.":
    "Apple 已不认识这部手机，所以 {environment} 删除了注册。请把推送通知关掉再打开。",
  "Apple refused it": "Apple 拒绝了它",
  "Apple's push service answered with an error (HTTP {status}). Check the APNs key on {environment}.":
    "Apple 推送服务返回了错误（HTTP {status}）。请检查 {environment} 上的 APNs 密钥。",
  "Apple's push service unreachable": "连不上 Apple 推送服务",
  "{environment} couldn't reach Apple's push service. Check the server's network.":
    "{environment} 连不上 Apple 推送服务。请检查服务器的网络。",
};
