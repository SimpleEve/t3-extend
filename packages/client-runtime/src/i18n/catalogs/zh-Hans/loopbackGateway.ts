// A remote environment's localhost forwarded to this computer's preview tabs: the mark beside the
// address bar and the cards a tab shows when it could not be forwarded.
export default {
  "the environment": "该环境",

  // The mark beside the address bar
  "localhost is forwarded to {environment}": "localhost 已转发到 {environment}",
  "localhost forwarding is off. Here, localhost is this computer":
    "localhost 的转发已关闭，这里的 localhost 指这台电脑",
  "Stop forwarding and use this computer's localhost": "停止转发，使用这台电脑的 localhost",
  "Resume forwarding": "恢复转发",
  "Stop allowing localhost:{port}": "取消放行 localhost:{port}",
  "Manage allowed ports…": "管理已放行的端口…",
  "Forwarding applies to all of {environment}'s tabs, not just this one. While it is on, external sites in these tabs connect directly, without the system proxy.":
    "转发对 {environment} 的所有标签页生效，不能只对某一个标签页关闭。转发开着时，这些标签页里的外部网站直接连接，不经过系统代理。",
  "Forwarding applies to all of {environment}'s tabs, not just this one.":
    "转发对 {environment} 的所有标签页生效，不能只对某一个标签页关闭。",

  // Cards
  "This port isn't served by a T3 terminal or agent":
    "这个端口上的服务不是 T3 的终端或 Agent 启动的",
  "{environment} only forwards services started by its T3 terminals and agents by default. This one was started some other way, or it has detached from the terminal or agent that started it (for example, moved to the background with nohup). If you trust it, you can allow this port.":
    "{environment} 默认只转发 T3 终端和 Agent 启动的服务。这个服务是用别的方式启动的，或者已经脱离了启动它的终端或 Agent（例如用 nohup 放到了后台）。如果你信任它，可以放行这个端口。",
  "Allow forwarding localhost:{port}": "允许转发 localhost:{port}",
  "From then on, any service on this port is forwarded. You can remove it in Settings → Browser.":
    "之后这个端口上的服务都会被转发，可以在 设置 → 浏览器 里移除。",
  "That isn't a valid port.": "这不是有效的端口。",
  "At most 64 ports can be allowed. Remove one in Settings → Browser, then try again.":
    "最多只能放行 64 个端口。请先在 设置 → 浏览器 里移除一个，再重试。",
  "Couldn't save the allowed port. Try again.": "没能保存放行的端口，请重试。",
  "Couldn't allow this port. Try again.": "没能放行这个端口，请重试。",
  "This service isn't listening on localhost": "这个服务没有监听 localhost",
  "It only listens on another address, which localhost can't reach. Make it listen on 127.0.0.1 as well.":
    "它只监听了别的地址，经 localhost 转发不到。让它同时监听 127.0.0.1。",
  "This port can't be forwarded": "这个端口不能转发",
  "T3 keeps this port for itself or for debugging.": "T3 把这个端口留给自己或用于调试。",
  "This service has debugging turned on": "这个服务带着调试参数运行",
  "A service started with debugging options such as --inspect can't be forwarded. Restart it without them.":
    "带着 --inspect 之类调试参数的服务不能转发。去掉这些参数后重新启动即可。",
  "The service on this port just changed": "这个端口上的服务刚刚变了",
  "Reload to try again.": "重新加载再试。",
  "Nothing is listening on port {port} in {environment}":
    "{environment} 上没有程序在监听 {port} 端口",
  "Start the service, then reload.": "启动服务后重新加载。",
  "Can't reach {environment}": "连不上 {environment}",
  "This tab opens by itself once {environment} is connected.":
    "{environment} 连上后，这个标签页会自动打开。",
  "Check its connection, then reload.": "检查连接后重新加载。",
  "This connection isn't allowed to forward localhost": "这个连接没有转发 localhost 的权限",
  "It needs the preview and terminal permissions.": "需要预览和终端两项权限。",
  "{environment}'s T3 can't forward localhost": "{environment} 的 T3 版本不支持转发 localhost",
  "Update T3 on {environment} to forward it.": "更新 {environment} 上的 T3 即可使用。",
  "This connection isn't encrypted, so localhost isn't forwarded":
    "这个连接没有加密，不转发 localhost",
  "Connect to {environment} over https, Tailscale (using its MagicDNS name) or SSH to forward it.":
    "请用 https、Tailscale（使用 MagicDNS 名字）或 SSH 连接 {environment}，即可转发。",
  "This looks like a Tailscale IP address. Use its MagicDNS name (*.ts.net) or https instead.":
    "这看起来是 Tailscale 的 IP 地址。请改用它的 MagicDNS 名字（*.ts.net）或 https。",
  "{environment}'s certificate isn't trusted": "{environment} 的证书不受信任",
  "This computer doesn't trust its certificate (private certificate authorities aren't supported yet). Use a certificate from a public authority, or connect over Tailscale.":
    "这台电脑不信任它的证书（暂不支持私有 CA）。请使用公共 CA 签发的证书，或通过 Tailscale 连接。",
  "Connections through T3 Connect can't forward localhost":
    "通过 T3 Connect 的连接不支持转发 localhost",
  "Connect to {environment} another way to forward it.":
    "改用其他方式连接 {environment} 即可转发。",
  "{environment} has port discovery turned off": "{environment} 关闭了端口发现",
  "Forwarding needs port discovery to be on there.": "转发依赖那边的端口发现，请先把它打开。",
  "Too many forwarded connections": "转发的连接太多",
  "Reload in a moment to try again.": "稍后重新加载再试。",
  "Couldn't start localhost forwarding": "无法启动 localhost 转发",
  "Forwarding to {environment} didn't start, so this tab stays closed. Retry, or use this computer's localhost instead.":
    "到 {environment} 的转发没能启动，所以这个标签页保持关闭。请重试，或改用这台电脑的 localhost。",
  "Reconnecting to {environment}…": "正在重新连接 {environment}…",
  "This page reloads when the connection is back.": "连接恢复后页面会自动重新加载。",
  "Couldn't forward localhost:{port}": "无法转发 localhost:{port}",

  // Settings → Browser → Localhost forwarding
  "Localhost forwarding": "本机服务转发",
  "Services on these ports were not started by a T3 terminal or agent. You allowed them to be forwarded.":
    "这些端口上的服务不是 T3 终端或 Agent 启动的，是你手动放行转发的。",
  "No allowed ports": "没有放行的端口",
  "Allowed {time}": "放行于 {time}",
  Remove: "移除",
  "Couldn't remove the port. Try again.": "没能移除这个端口，请重试。",
  "No connected remote environment can forward localhost.":
    "没有已连接、能转发 localhost 的远程环境。",

  // The preview panel of an environment that is not connected
  "Can't reach {environment}. Browser previews come back once it is connected.":
    "连不上 {environment}，连上后浏览器预览会恢复。",
} satisfies Record<string, string>;
