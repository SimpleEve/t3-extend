# Remote access

Drive T3 Code from your phone, browser (`app.t3.codes`), or another desktop app while your agents run on a host computer or server. The host must stay awake and running while you work.

## T3 Connect (recommended)

T3 Connect links your host to your other devices without router port-forwarding.

- **Desktop host**: Open **Settings → Sharing & access**, sign in, and turn on **T3 Connect** (note: closing the desktop app's last window stops its local server—use the [background service](./background-service.md) for unattended access).
- **CLI / headless host**: Run `t3 up` (or `t3 connect` / `t3 up --connect --lan --yes` for non-interactive scripts) and complete the printed sign-in link on any device. Check status with `t3 status [--json]`.
- **Other devices**: Sign in to the same T3 Connect account and pick the environment.

### Approve new devices

By default, any device signed into your T3 Connect account can connect. Turn on **Require approval for new devices** in **Settings → Sharing & access** on the host so new devices must present a short code (valid 10 minutes) that you approve from an existing device or via `t3 auth connect-device approve <code>`. Revoke devices anytime in **Settings → Sharing & access** or `t3 auth connect-device revoke <code>`.

### More machines with T3 Chat

Free T3 Connect accounts can link up to **3 host machines** (phones and browsers don't count). Link a paid T3 Chat account from your account menu → **T3 Chat → Link T3 Chat** to raise the limit to **10** (Pro) or **100** (Premier).

## Pair over a LAN or private network

- **Desktop host**: Enable **Settings → Sharing & access → Network access** (restarts desktop) and create a one-time pairing link.
- **CLI host**: Run `t3 up --lan` (background service) or `t3 serve --lan` (foreground), then run `t3 pair` to generate a QR code / pairing URL (`t3code://pair` opens directly in the desktop app).
- **Hosted web app (`app.t3.codes`)**: Requires an HTTPS endpoint (T3 Connect or Tailscale HTTPS). For plain HTTP on a LAN, open the direct pairing URL in a local browser or pair from the desktop/mobile app. For custom CAs on Android, install the CA certificate in Android security settings.
- **Session lifetime**: Paired devices stay signed in while active; sessions unused for 30 days must re-pair.

### Reach one machine several ways

A host can have multiple routes (LAN, Tailscale, VPN, public URL, SSH, T3 Connect). T3 Code automatically learns LAN and Tailscale routes when network access is enabled, connects over the fastest working route, and switches back to higher-priority routes when you return home. Reorder or add routes in **Settings → Environments** (**Add route**).

### Tailscale HTTPS

Join both devices to a tailnet with [MagicDNS and HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) enabled (on Linux, grant [operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)).
T3 Extend publishes on HTTPS port 8443, so it can stay on next to official T3 Code,
which uses 443, and turning either off leaves the other's route alone.

- **Desktop**: Enable **Settings → Sharing & access → Tailscale HTTPS**.
- **CLI**: Run `t3 serve --tailscale-serve` or `t3 pair --tailscale` (T3 Extend uses port 8443, so the pairing link looks like `https://machine.tailnet.ts.net:8443/`; use `--tailscale-serve-port` if 8443 is taken; remove with `tailscale serve --https=8443 --set-path=/ off`).

### Balance new threads across machines

On web and desktop with 2+ connected machines, enable **Settings → Environments → Load balancing** (per client) to auto-select a host for new threads in shared projects. Set each machine to **Prefer**, **Normal**, **Less often**, or **Manual only**.

### Your own server

<!-- fork: T3 Extend only. Not part of upstream T3 Code. -->

Connect your computers and phones through a server you run yourself, without
T3 Connect or Cloudflare. Each computer and phone has its own key and the
server stores only the public halves, so removing one device never affects the
others and there is no shared password to rotate. Whoever runs the server can
read your traffic, because HTTPS ends there. Use a machine only you control.

To start:

1. Set up the server on a Linux VPS with a domain you own. Follow
   [Self-hosted connection](../../infra/self-host/README.md). It ends by printing
   a one-time invite for your first computer. On a server in mainland China the
   domain must be registered with your cloud provider. If the VPS already hosts
   other websites, the guide has a section for letting this setup take over
   ports 80 and 443 and forward those sites too.
2. On the first computer, open **Settings → Sharing & access → Your server**,
   choose **Join my server**, and paste the invite. Check that the address shown
   is your own server before you confirm.
3. From that computer, choose **Invite a device**. For another computer, paste
   the invite in the same place on that computer. For a phone, scan the code or
   paste the invite in the phone's **Settings → Your server**. Invites work once
   and expire after 15 minutes.

Every computer that has joined then shows up as an environment on your other
computers and phones, including ones that join later. To keep a computer out of
sight, see [Hiding a computer](#hiding-a-computer) below.

To remove a device, choose **Remove** next to it in **Settings → Sharing &
access → Your server** on a computer that has joined, or run `./t3x revoke
<name>` in the server's folder on the VPS (`./t3x devices` lists the names).
It takes effect within about a minute, and a computer that was offline then is
cut off once it reaches the server again. After that:

- The removed computer or phone says it was removed from your server. A computer
  shows **Join my server**; it needs a new invite to come back.
- The removed computer's public address stops answering.
- On your other computers, it leaves the device list and its environment
  disappears. Projects that were bound to it show as "Unavailable environment".

#### Hiding a computer

By default every device can see every computer. In the desktop app on a computer
that has joined, choose **Visibility → Change** in **Settings → Sharing & access → Your server**
to decide who can see that computer:

- **Visible to all devices** is the default.
- **Hidden from all devices** hides it from everyone, including devices that
  join later.
- **Hidden from selected devices** hides it from the computers and phones you
  tick. Devices that join later can see it.
- **Visible only to selected devices** shows it only to the ones you tick.
  Devices that join later cannot see it.

A device that is hidden from a computer can't see it and can't sign in to it:
the computer disappears from that device's list as if it had been removed (its
environment goes away, and projects bound to it show "Unavailable environment"),
and the computer itself refuses that device's sign-ins. Turning hiding on signs
the affected devices out of that computer at once. Turning it off brings the
computer back within about a minute.

It works one way and only on that computer: a hidden computer still sees and uses
every other device on your server, provided those computers run this version. **Update
every computer you hide a computer from**: one that is still on an older version
can't see the hidden computer either, and it also makes the hidden computer unable
to connect to it. It only covers your own server. Pairing links, a LAN or
Tailscale address you paired by hand, browsers and T3 Connect are not affected. The setting is saved on the computer itself. If your server is an
older version it cannot hide the computer from other devices' lists and the
page says so, but the computer still refuses the devices you chose. Update the
server (see its guide) to complete it.

Phones are not environments and have no such setting; they can only be chosen as
a device to hide from. A device that is hidden from a computer can't remove it
either. Remove it with `./t3x revoke <name>` on the VPS, from a computer it is
not hidden from, or have the computer **Leave this server**; `./t3x devices`
lists every device and marks which computers hide from whom. On a computer
without the desktop app, use `t3x devices visibility` (`show`, `all`, `none`,
`hide <device…>` and `only <device…>`; a device that joined in the last minute
may need its id, which `./t3x devices` shows). A change made that way closes the
open connections of the devices it excludes within about a minute, when the
running server next syncs.

Things that may surprise you:

- A newly joined device can take a few seconds to a minute to be recognized by
  the other computers. Until then you see "Waiting for that computer to
  confirm…".
- A computer that cannot reach the server keeps working from its last device
  list. After 3 minutes the settings page says it can't reach the server. After
  24 hours it warns you. After 7 days it stops accepting new device logins until
  it syncs again.
- If a computer leaves your server and joins again, its address on the server
  changes, for example from `mac` to `mac-2`.
- A phone's key exists only on that phone. For a new phone, join again and
  remove the old one.
- Phones can see the device list but cannot invite or remove devices.

On a computer without the desktop app, use `t3x devices join <invite>`,
`list`, `invite`, `remove`, `leave` and `tunnel`. `list` only reads what was
last synced and does not contact the server; `tunnel status` shows whether the
tunnel client is installed and connected.

### Your own public address (Advanced)

If you run a reverse tunnel or proxy on a server you control, such as frp behind
Caddy on a VPS, T3 Extend can use that HTTPS address instead of T3 Connect.
This is the manual alternative to [Your own server](#your-own-server), which
sets up per-device keys for you. The older shared-token setup is in
[infra/self-host/advanced](../../infra/self-host/advanced/README.md).

1. In the desktop app, open **Settings → Sharing & access → Public addresses**
   and add the address, for example `https://t3.example.com`. It must be
   `https://` and have no path. Network access can stay off; the tunnel reaches
   the app over `127.0.0.1`.
2. Create a pairing link and choose the address under **Share**.

Devices that already paired over your LAN or tailnet learn the address the next
time they connect, and use it when the faster routes don't answer. Removing the
address stops reporting it; to cut off a device, revoke its session.

**Tunnel command** can keep the tunnel client running while the app is open,
for example `frpc -c ~/frpc.toml`. The command runs on this computer as you,
and only this computer's desktop app can change it.

On a headless server, save the address with `t3 up --public-url <url>` (repeat
for several, `--clear-public-urls` to remove them) or set `T3CODE_PUBLIC_URLS`,
and print a QR code with `t3 pair --base-url <url>`.

The same server can also push alerts to your phone without Google services; see
[Push without Google](./mobile-notifications.md#push-without-google).

Whoever runs the proxy can read your traffic, because TLS ends there. Use a
server only you control. Failed pairing codes are rate limited per client
address: after 20 failures in a minute, that address waits 60 seconds. Other
devices, and this machine itself, can still pair.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment → SSH** and enter a host or SSH alias (e.g. `user@example.com`). T3 Code downloads its runtime to `~/.t3/runtime` on the Linux or Apple Silicon macOS host, starts or reuses a server, and manages port forwarding automatically.

- Provider CLIs must be on a non-interactive login shell's `PATH` (check with `ssh user@example.com 'sh -lc "command -v claude codex"'`).
- For 2FA/Duo hosts on macOS/Linux, enable SSH `ControlMaster` in `~/.ssh/config` and open a terminal SSH session first.
- Revoke unused SSH sessions in **Settings → Sharing & access** or `t3 auth session revoke <id>`.

## Browser on a remote environment

<!-- fork: the desktop app renders tabs you open for other environments locally (upstream #16827). -->

Browser tabs belong to the host environment so you and your agents share them from any device.

- **Streaming & local loading**: Web and mobile stream tabs from the host. In the desktop app, tabs you open for a remote environment load locally while routing `localhost` requests to the host over the **preview tunnel** (so element picker and annotations work locally).
- **Port forwarding (desktop)**: Forward any remote host port to your local `localhost` via the thread's **Servers** list or **Forwarded ports** in the command palette (`Cmd/Ctrl-click` forwards and opens in your browser).
- **Open on this device (mobile)**: Tap **Open on this device** on a streamed `localhost` tab or long-press a `localhost` link in chat for native touch scrolling.
- **Disable preview tunnel**: Turn off **Settings → Sharing & access → Preview tunnel** on the host (or via [managed policy](./managed-policy.md#other-capabilities)) to disable port forwarding and **Open on this device** (streamed tabs continue working).
- **New tab on Android** (T3 Extend): Tap the globe in a thread's header to open a new tab: enter an address, or pick one of the host's local servers. The page runs on the host, so `localhost:5173` is the host's dev server, not your phone. The **+** in the browser's header opens another tab. Opening tabs needs a connection that can operate the browser; read-only connections can still watch.
- **Take control**: Click **Take control** before typing into an agent's tab, and release control when done.
- **Local servers**: T3 Code lists listening ports from your terminals and agents as `http://localhost:<port>` (set a script's **Preview URL** for HTTPS or subpaths). Disable discovery with `T3CODE_PORT_DISCOVERY=0`.

### Localhost on a remote environment

<!-- fork: T3 Extend only. Not part of upstream T3 Code. -->

T3 Extend forwards a remote environment's `localhost` exactly as described
above: any service listening on the host's loopback can be opened, whoever
started it, including one started with `nohup`. Only the T3 server's own port
is not forwarded. Turn off **Settings → Sharing & access → Preview tunnel** on
the host to stop it.

### Browser host setup

The first server browser tab downloads ~120 MB headless Chromium (shared with [HTML renders](./html-renders.md)). On Ubuntu 23.10+ or minimal Linux containers, run the one-time setup command on the host:

```sh
sudo t3 browser setup
```

This installs an AppArmor profile for Chrome's sandbox plus missing libraries and fonts. Never run the T3 server as root (Chrome's sandbox rejects root); if sandboxing is impossible on your host, set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the server environment and restart.

## Link another environment

Link two T3 Code machines (beta) so agents on one can launch, message, delegate to, and manage threads on the other.

1. Enable **Settings → Labs → Linked environments** on **both** machines (or `"linkedEnvironmentsEnabled": true` in `userdata/settings.json`).
2. On the source machine, open **Settings → Environments → Linked environments → Link** (or drag from one machine's `+` to another on the Environments map, or run `t3 environment link <address> --pairing-code <code> --access <mode>`). Use **Link several…** or `--from <file>` for batch linking.
3. Links are one-way (tick **Also link … back** for two-way) and do not chain. Links expire after 30 days of inactivity and can be revoked in **Settings → Sharing & access** or **Forget**.

- **Access boundary**: Agents never get more permissions on the target than the link's access level or their own thread mode. Below Full access, linked agents can only modify threads they started and skip project setup scripts.
- **Delegation**: Agents can target a linked machine with `delegate_task`, or ask you to link an unlinked machine via an in-thread approval card.

### Read a linked machine's threads

Open a delegated task or thread link on a linked machine to follow it live (read-only) in the right panel without pairing your client directly. Click **Connect to interact** to pair and take action (one-click if the link has Full access and you can manage access). Files, images, and HTML renders stay on the remote machine until you connect directly.

## Manage or revoke access

Manage pairing links and active client sessions in **Settings → Sharing & access** or via `t3 auth --help`. To remove a device from [Your own server](#your-own-server), see the removal steps there.

- **Scoped tokens**: Pass `--scope <scope>` (repeatable) to `t3 pair`, `t3 auth pairing create`, or `t3 auth session issue` to restrict permissions (e.g. `orchestration:read`, `source-control:write`, `filesystem:read`, `filesystem:write`, `terminal:operate`, `relay:configure`). Re-pair with a fresh link to change an existing client's scopes.
- **Deregister from T3 Connect**: Open your account menu → **T3 Connect → Deregister** (or `t3 connect unlink` / `t3 connect logout` on CLI hosts). Idle tunnels are automatically cleaned up after 5–10 minutes offline and recreated on reconnect (hosts on older versions offline for 7+ days need an update first).
- Treat pairing URLs and codes as passwords—never paste them into logs or screenshots.

## Desktop app as a remote only

Switch off **Settings → Environments → Local environment** in the desktop app to run with no local server, WSL backend, or incoming connections while continuing to drive remote hosts (if a local background service uses the same T3 home, **Open in** still works locally).

## Troubleshooting

See [T3 Connect troubleshooting](./t3-connect-troubleshooting.md) for step-by-step connection diagnostics, and [Outside agents](./outside-agents.md) for MCP connections.
