# Set up a T3 Extend server and connect your phone and other computers

English | [简体中文](./server-setup.zh-CN.md)

This guide starts from zero. It shows how to run the T3 Extend server and how to pick a way for your phone, other computers, and browsers to connect to it. It assumes you already have T3 Extend. You do not need to know how it works inside.

A few terms first:

- **Host**: the computer that runs the server and the agents. Your projects, provider logins, and the agents' work stay on it.
- **Client**: an interface you use to control the host. This includes the desktop app, the web app in a browser, the Android app, and the iPhone app.
- **Pairing link**: an address or QR code that carries a one-time code. A client trades it for a session that you can revoke on its own. **It works like a credential.** Do not paste it into screenshots, logs, or tickets.

Interface names in this guide are the English ones. If you use the Simplified Chinese interface, see the [table at the end](#interface-names-in-simplified-chinese). Commands are always written as `t3x`, the command-line name of T3 Extend. It does not interfere with `t3`, the command of official T3 Code. Where the upstream docs say `t3`, use `t3x` in T3 Extend.

## 1. Choose how to connect

| Method          | Good for                                                                    | You need                                                                                 | Security                                                                                                                                | Phone                                                              |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| This computer   | Using the host itself                                                       | Nothing                                                                                  | Only this computer can reach it by default                                                                                              | Not applicable                                                     |
| LAN pairing     | Home or office, devices on one network                                      | **Network access** on the host (or `--lan`)                                              | Plain http. Anyone on the same network can read the traffic. The pairing code is the only lock.                                         | Yes. Android and iPhone both allow plain http.                     |
| Tailscale       | Devices on different networks, and you already use Tailscale                | Both ends in the same tailnet. MagicDNS and HTTPS certificates turned on for the tailnet | Encrypted by Tailscale. The HTTPS port is 8443.                                                                                         | Install Tailscale on the phone and join the tailnet                |
| Your own server | Reaching your home computer from anywhere, with no VPN on the phone         | Your own Linux VPS, a domain, two DNS records, Docker on the VPS                         | HTTPS ends on your VPS, so **the VPS can see plain text**. Each device has its own key. Losing one device means removing only that one. | Yes. For phone push, see [section 8](#8-phones-android-and-iphone) |
| SSH             | The desktop app driving a remote Linux machine or another Apple silicon Mac | SSH access to that machine, with providers installed on it                               | Runs over SSH. The remote side runs the server of official T3 Code, so there is no T3 Extend forwarding or push.                        | No. The desktop app sets up SSH environments.                      |

How to choose:

- For use at home only, choose LAN pairing.
- If you already have Tailscale, choose Tailscale. You do not need to buy a server.
- If you need access away from home and do not want a VPN, or you want Android push, choose your own server. iPhone push works with any of these methods.
- If you want the desktop app to drive a remote Linux machine, choose SSH.

You can use several of these at once. When a host has more than one route, the client sorts them by speed and uses the first one that connects. See [Reach one machine several ways](../user/remote-access.md#reach-one-machine-several-ways) in the upstream docs.

### T3 Connect is not available in T3 Extend by default

T3 Connect needs the official relay address and the public config of the official sign-in service. Official builds get these from the official `.env`. T3 Extend does not have this `.env`, so:

- The T3 Connect switch and commands (`t3x connect`, `t3x up --connect`) do not work. `t3x connect` tells you that T3 Connect is not available in this build.
- Guest links and passkeys are also unavailable by default.
- The sign-in redirect is tied to the official URL scheme. Even if you supply your own `.env`, T3 Connect sign-in may fail.

T3 Extend replaces it with the methods above. Your own server is the replacement for T3 Connect. It does not go through the official relay or through Cloudflare.

## 2. Install the server

### Desktop app

T3 Extend has a desktop app for macOS (Apple silicon) only. Once you have `T3-Extend-<version>-arm64.dmg`, install it into Applications by following [the upstream steps](../user/install.md#t3-extend-on-macos). The first time you open it, allow it in Privacy & Security and let it use the keychain.

The desktop app has its own backend. Opening the app gives you a server, and it can also be a host that other devices connect to. By default only this computer can reach it. To let other devices in, follow the sections below.

T3 Extend and official T3 Code can be installed on the same computer. Data, commands, and ports are separate:

|                 | Official T3 Code | T3 Extend     |
| --------------- | ---------------- | ------------- |
| T3 home         | `~/.t3`          | `~/.t3extend` |
| Default port    | 3773             | 3873          |
| Tailscale HTTPS | 443              | 8443          |
| Command line    | `t3`             | `t3x`         |

If the default port is taken, the server moves to another port. Use the port in the pairing link or in the log. For the details of running both side by side, see [the upstream docs](../user/install.md#running-next-to-official-t3-code) and [FORK.md](../../FORK.md#共存保证) (in Chinese).

The Android app is an APK. It is not in any app store. Copy the APK to the phone and open it, or run `adb install -r <apk>` on a computer. It installs next to the official T3 Code app and does not replace it (see [the upstream docs](../user/install.md#mobile-app)).

The iPhone app has no download. You build it on your own Mac and sign it with your own Apple account; see [iOS: build it yourself](../user/install.md#ios-build-it-yourself).

### The `t3x` command

The desktop app ships with the `t3x` command. A freshly installed app sets it up on first launch. To install or remove it later, go to Settings → About. After that, open a new terminal and it is available:

```bash
t3x                # Start the server in this terminal and open the web app in a browser
t3x serve          # Start the server in this terminal without a browser, and print pairing info (the background service runs this)
t3x serve --lan    # Same, and also allow devices on the LAN and the tailnet to connect
t3x pair           # Make a pairing QR code and link for a server that is already running
t3x --help         # List all subcommands
```

Notes:

- **Machines without the desktop app** (for example a Linux server): install `t3x` with the script. It works on macOS (Apple silicon) and Linux (x64 and arm64). It downloads the archive from the [Releases](https://github.com/SimpleEve/t3-extend/releases) page, checks it against `SHA256SUMS`, and installs into `~/.t3extend`. It never touches official T3 Code's `~/.t3` or its `t3` command. Do not use the official `install.sh`: it installs the official `t3`.

  ```bash
  curl -fsSL https://raw.githubusercontent.com/SimpleEve/t3-extend/main/scripts/install-t3x.sh | sh
  ```

  `T3X_VERSION` picks a version, `T3X_HOME` and `T3X_INSTALL_BIN_DIR` change where it installs (the defaults are `~/.t3extend` and `~/.local/bin`). If `~/.local/bin` is not on your `PATH`, the script prints the line to add. Run the script again to repair the install; `t3x update` moves to the newest release.

- Some `t3x` help text still says `t3`. That is the upstream wording and does not affect use.
- Set the data directory with `--base-dir <directory>` (the same as the environment variable `T3CODE_HOME`). The default is `~/.t3extend`.

### Run in the background from boot

By default, quitting the desktop app (Cmd+Q) shuts down the server, and your phone goes offline. There are two ways to keep the server running.

**The desktop app switch (packaged macOS app)**

Turn on Settings → Maintenance → Keep running in the background. It is the same as `t3x service install`. Turning it off is the same as `t3x service uninstall`. When it is on:

- When you quit the app, the background service keeps running. Your phone stays connected and push keeps working.
- The service uses the runtime that ships inside the app and downloads nothing. The app must stay in the Applications folder. A copy opened directly from the disk image is refused.
- Only one server can use a given set of data. While the app is open, it uses its own server and the background service pauses. When you quit the app, the service starts again and your phone reconnects.
- If you move or delete the app, this row tells you. Open the app from its new location, then turn the switch off and on. After you install a new version of the app, the row offers Repair.
- If the service could not start when you quit, the next time you open the app it tells you why and offers Retry. If the app crashes or is force quit, the service stays stopped until you next open and quit the app, or sign in again.

On macOS, the background service starts when you sign in and stops when you sign out. Keep the Mac signed in and do not let it sleep.

**Command line**

```bash
t3x service install     # Install and start
t3x service status      # Show the status and the log location
t3x service restart
t3x service uninstall
t3x up --lan            # Install the service and allow LAN and tailnet connections (writes T3CODE_LAN=true to service.env)
```

Limits: only a **`t3x` installed by the desktop app, on macOS,** makes the service use the runtime inside the app. In every other case (the install script, npm, or a machine without the desktop app), `t3x service install` uses a server package from the Releases page. The install script has already downloaded it, so the service reuses it; otherwise `t3x service install` downloads it, and so does `t3x update`. Set the environment variable `T3CODE_RELEASE_BASE_URL` to use your own release mirror. Releases only carry macOS (Apple silicon) and Linux (x64, arm64) packages, so this does not work on Windows yet.

The service's environment variables go in `service.env` under the T3 home (in T3 Extend, `~/.t3extend/service.env`). For example, `T3CODE_PORT=3873`. After you change it, run `t3x service restart`.

For more, see the upstream [background service docs](../user/background-service.md). The desktop switch is described in [the macOS section of that page](../user/background-service.md#t3-extend-desktop-app-on-macos).

## 3. This computer

Using the host itself needs no setup. Open the desktop app, or run `t3x` in a terminal. By default the server listens only on this computer, so other devices cannot reach it.

## 4. LAN pairing

**Good for**: a phone, another computer, or a browser on the same network as the host.

> **Risk of plain http.** LAN addresses are `http://`. Anyone on the same network can read the traffic, including the pairing code and the sessions after it. With network access on, anyone on the network who knows the port can reach the server, and the pairing code is the only lock. Use it only on networks you trust. Do not turn it on over public Wi-Fi.

### Turn it on at the host

- Desktop app: Settings → Sharing & access, then turn on Network access. The switch restarts the app. Devices already connected over the LAN are disconnected. You can turn it off in the same place.
- Command line: `t3x serve --lan` (runs in the foreground), or `t3x up --lan` (installs the background service with it on).

Once on, the server listens on the local network and on Tailscale addresses. It does not listen on public addresses.

### Create a pairing link

- Desktop app: Settings → Sharing & access → Authorized clients → Create link. Pick an address the other device can reach (the loopback address `127.0.0.1` works only on this computer). A link created on the settings page can be copied only from the client that created it, and only while that page stays open. After you leave or refresh the page, create it again.
- Command line: run `t3x pair` against a server that is already running. It prints a QR code and a link in the terminal. Common options: `--ttl <duration>` (default 5 minutes), `--label <name>`, and `--scope <scope>` (repeatable; limits what the link can do). Without `--scope` the link gets every permission, including managing access. Give only what is needed.

Use a new one-time link for every new device. After pairing, the device reconnects without the original code.

### How a client joins

- **Browser**: open the link. It looks like `http://<host LAN address>:3873/pair#token=…`.
- **Desktop app**: open the `t3extend://pair` link printed in the terminal. The app asks you to confirm the server address before adding it. Or use Settings → Environments → Add environment and paste the link.
- **Phone app (Android and iPhone)**: scan the QR code (with the system camera or Scan QR code in the app), or use Settings → Environments → Add environment and paste the link. If you type an IP address with no protocol, the phone treats it as http. If the host uses https, write `https://`.

### Revoke

- Desktop app: in Settings → Sharing & access → Authorized clients, revoke a device's session, or revoke a link that is not used yet. Revoking a link only stops new pairing. To cut off a device that has already paired, revoke its session.
- Command line: `t3x auth session list` shows sessions, and `t3x auth session revoke <session id>` revokes one. `t3x auth pairing list` and `t3x auth pairing revoke <id>` manage links that are not used yet.

Requests that trade a pairing code for a session are rate limited on failure. If one client address fails 20 times in 1 minute, it is locked out for 60 seconds (the server returns 429). Other devices are not affected.

For more (route order, permission scopes), see [Pair over a LAN or private network](../user/remote-access.md#pair-over-a-lan-or-private-network) and [Manage or revoke access](../user/remote-access.md#manage-or-revoke-access) in the upstream docs.

## 5. Tailscale

**Good for**: devices on different networks, when you already use Tailscale. T3 Extend uses HTTPS port **8443**, **not 443**. Port 443 belongs to official T3 Code, and T3 Extend never creates, changes, or deletes anything on it.

### Before you start

- Put the host and the clients in the same tailnet. The phone also needs Tailscale installed and signed in to the same tailnet.
- Turn on MagicDNS and HTTPS certificates for the tailnet. See [Tailscale's HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates).
  - Once HTTPS certificates are on, your tailnet's machine names (`<machine>.<tailnet>.ts.net`) go into public certificate transparency logs, where anyone can look them up.
- `*.ts.net` names must resolve on every machine. MagicDNS showing as on in the admin console does not mean this machine can resolve them. On macOS, a Homebrew `tailscaled` only adds a search domain and no resolver for `ts.net`, so `ping <machine>.<tailnet>.ts.net` says the host is unknown. Add the file yourself:

  ```bash
  echo "nameserver 100.100.100.100" | sudo tee /etc/resolver/ts.net
  ```

  Tailscale's official macOS app writes this file itself.

- On Linux, T3 Extend also needs permission to manage Tailscale. For a non-root user, see [operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission).

If any of these is missing, T3 Extend still starts. It just cannot add the HTTPS route.

### Turn it on at the host

- Desktop app: Settings → Sharing & access, then turn on Tailscale HTTPS. Turn it off in the same place to remove the route.
- Command line: `t3x serve --tailscale-serve` starts the server with HTTPS. For a server that is already running, `t3x pair --tailscale` does the same and also makes a pairing link. If the port is taken, use `--tailscale-serve-port <port>` to pick another. Passing 443 is changed to 8443.
- With Tailscale HTTPS, keep the server on its default local address. Do not add `--host <tailnet IP>`. The HTTPS route forwards to the address the server listens on. When the server listens only on the tailnet IP, the route connects but never answers (seen on macOS), and the app still shows it as connected.

The pairing link looks like `https://<machine name>.<tailnet>.ts.net:8443/`. The mapping that `t3x pair --tailscale` creates survives restarts. Remove it by hand:

```bash
tailscale serve --https=8443 --set-path=/ off
```

### How a client joins and how to revoke

Clients join and revoke the same way as in the previous section. Open the link in the same way, and revoke sessions under Authorized clients.

### Connect directly with a Tailscale IP

With network access on (or `--lan`), the server also listens on Tailscale addresses, so you can pair directly with `http://100.x.x.x:3873`. This is plain http, though it runs inside Tailscale's encrypted tunnel.

### A leftover 443 route from an older version

An older version of T3 Extend left a route on 443. It is not removed automatically. First run `tailscale serve status` and check that 443 points to `http://127.0.0.1:3873` (the T3 Extend server). Then run `tailscale serve --https=443 --set-path=/ off`. If it points somewhere else (for example 3773), it belongs to official T3 Code. Leave it alone. For the full steps, see [the upstream docs](../user/install.md#running-next-to-official-t3-code).

## 6. Your own server

**Good for**: reaching your home computer from anywhere. You run a small service (registry + frps + Caddy) on your own VPS and register the host with it. Then your phone and other computers connect back through `https://<name>.t3.example.com`. The traffic does not go through T3 Connect or Cloudflare.

Know three things first:

- **The VPS can see plain text.** HTTPS ends on your VPS, so it can see your conversations with the agent and the contents of your files. Use only a machine where you alone have root. Do not use a shared machine or a "free frp service" from an unknown source.
- **Each device has its own key.** Each computer and phone has its own P-256 key, and the VPS keeps only the public key. Removing one device does not affect the others, and there is no shared password to change.
- **For a server in mainland China, the domain must be filed (备案) with that cloud provider.** Otherwise the provider blocks ports 80 and 443, and the certificate cannot be issued. If you have not filed, use a server outside mainland China (Hong Kong, Japan, and so on).

### The steps and the key decisions

1. **Prepare**: a Linux VPS with a public IP (1 core and 1 GB is enough), a domain, and two DNS records that both point at the VPS (`t3.example.com` and the wildcard `*.t3.example.com`; each computer gets its own subdomain, and the push server uses one too). Docker and the compose plugin installed. Ports 80/tcp and 443/tcp reachable from outside and not used by another service (including the cloud provider's security group).
2. **Install the service**: put `infra/self-host/` from the repository onto the VPS and run `./setup.sh --domain t3.example.com` in that directory. The first run builds the images, which takes about a minute. At the end it prints the first **invite** (a string that starts with `t3x1.`, plus a QR code). You can run the script again at any time. It does not reset your data.
3. **Check that HTTPS works**: from any computer, run `curl -sS https://t3.example.com/v1/info`. It should return JSON that contains `registryId`.
4. **Add the first computer** (next subsection).
5. **Add later devices** by inviting them from a desktop app that has already joined.

Why these decisions were made:

- Only Caddy's ports 80 and 443 are published. The frps control connection goes through Caddy's 443 (path `/~!frp`). Ports 7000 and 8080 are not open to the outside.
- A push server (ntfy) is included by default. Use `--no-ntfy` to leave it out.
- If the VPS already has other websites on 80/443, you can let the Caddy from this setup take over and forward to those sites. That is a separate way of installing. All the details of the VPS deployment, day-to-day operation, upgrades, backups, removal, and local trials are in [infra/self-host/README.md](../../infra/self-host/README.md) (in Chinese), so they are not repeated here. A few sections are commonly useful: [日常运维](../../infra/self-host/README.md#日常运维) (day-to-day operation), [这台 VPS 上已经有别的网站](../../infra/self-host/README.md#这台-vps-上已经有别的网站) (this VPS already has other websites), and [本地试用](../../infra/self-host/README.md#本地试用) (local trial).

### Add the first computer (desktop app)

1. On the VPS, in the `infra/self-host` directory, run `./t3x invite --kind computer` to get an invite. An invite is valid for 15 minutes and works once. Pass it along the way you would pass a password.
2. In the desktop app on that computer, open Settings → Sharing & access → Your server, choose Join my server, and paste the invite. Check that the dialog shows your own domain before you join.
3. After joining, the computer gets an address such as `https://<name>.t3.example.com`.

This computer's server must keep running for others to reach it at that address. Keep the desktop app open, or turn on Keep running in the background. When the computer sleeps, shuts down, or goes offline, its address cannot be reached and open sessions are dropped.

### A computer without the desktop app

Install `t3x` with the [install script](#the-t3x-command) first, then use the command line:

```bash
t3x devices join <invite>      # Join. --name <name> sets the display name; the default is the hostname
t3x devices tunnel install     # Download a pinned version of frpc (with a SHA-256 check)
t3x devices tunnel status      # Show whether the tunnel client is installed and connected
t3x devices list               # Read the locally stored device list only, with no network
t3x devices invite             # Make an invite for another device. The default is a phone; --kind computer makes one for a computer
t3x devices remove <name>      # Remove a device
t3x devices visibility show    # Who can see this computer. Also: all, none, hide <device…>, only <device…>
t3x devices leave              # Take this computer out
```

### Add a phone or another computer

- **Another computer**: in a desktop app that has already joined, choose Invite a device, set the type to computer, and copy the invite. On the new computer, open the desktop app, go to Settings → Sharing & access → Your server, choose Join my server, and paste it. For a computer with no interface, use `t3x devices join`.
- **Phone (Android and iPhone)**: in a desktop app that has already joined, choose Invite a device and set the type to phone. It shows a QR code. You can also run `./t3x invite --kind phone` on the VPS. On the phone, open Settings → Your server and choose Scan QR code or Paste invite. The phone asks you to confirm the server's domain, and sends the request only after you confirm.

Every computer that has joined shows up as an environment on your other computers and phones, and so does each one that joins later. It takes a few seconds to a minute for a newly joined device to be recognized by the other computers. During that time you see "Waiting for that computer to confirm…".

A phone can only view the device list. It cannot invite or remove devices. The phone's key exists only on that phone. If you get a new phone, join again and remove the old one.

### Connect from a browser

A browser does not join Your server and does not hold a device key. It keeps using pairing links. When you create a pairing link in a desktop app that has joined, you can pick this computer's own address (shown by hostname). You can also use the command line:

```bash
t3x pair --base-url https://<name>.t3.example.com
```

The command first probes this address from the computer. If the address answers as a different environment, the command fails. If it cannot connect, or the answer does not look like a T3 server, the command only gives a warning. The link works only once the address really points to this server. The warning "did not answer from this machine" does not always mean the address is wrong. You also get it when the tunnel has not come up yet, or when this computer cannot resolve its own MagicDNS name, while other devices reach the address fine. Try it from a client first.

### Revoke

Pick any one of these:

- Desktop app: on a computer that has joined, open Settings → Sharing & access → Your server and click Remove next to the device.
- On the VPS: `./t3x revoke <name>`. `./t3x devices` lists all the names.
- A computer with no interface: `t3x devices remove <name>`.

It takes effect in about a minute. A removed device cannot get new access, and its tunnel is refused at the next heartbeat (about 30 seconds). **A computer that was offline when it was removed** is revoked only after it reconnects to the server. A removed computer shows Join my server and needs a new invite to come back. By default its subdomain is not given to anyone else. To take it back, use `./t3x release <subdomain>`.

If you remove a device from another process, such as `t3x devices remove` or `t3x auth session revoke` on a computer, the running server drops the old connections only at the next sync (about 60 seconds).

### Hiding a computer from other devices

A computer can hide itself from chosen devices: Settings → Sharing & access → Your server → Visibility, or `t3x devices visibility`. See [Your own server](../user/remote-access.md#hiding-a-computer) for the four modes. The registry must be the version that stores the setting (database schema 2, migrated on the first start, with no rollback to the older image). `./t3x devices` lists every device and marks what each computer hides; `./t3x revoke` works on a hidden computer too.

### Behavior to know

- When a computer cannot reach the server, it keeps using the last device list. After 3 minutes without a sync, the settings page says "Can't reach your server". After 24 hours it shows a warning. After 7 days it stops accepting new device sign-ins, and resumes once it syncs again.
- If a computer leaves and joins again, its subdomain changes, for example from `mac` to `mac-2`.
- When you reload or restart Caddy or frps on the VPS (including re-running `setup.sh` for an upgrade), all tunnels drop for a few seconds and reconnect on their own. You do not need to join again.

### The older scheme

`infra/self-host/advanced/` holds an earlier scheme that uses a shared token. It matches the Public addresses entry under Settings → Sharing & access → Advanced in the desktop app. It is kept for reference only and is no longer maintained. See [advanced/README.md](../../infra/self-host/advanced/README.md) (in Chinese).

## 7. Localhost forwarding in remote environments

**What it is for**: in the desktop app you are connected to a remote environment B (for example another Mac, reached through your own server or Tailscale). A service on B listens only on its `localhost`, and you want to open `http://localhost:<port>` in the built-in browser. This works exactly as in the official app: the page renders on this computer and its connections go through B's preview tunnel to B's loopback. Any port on B can be opened, whoever started the service, except the T3 server's own port.

To turn the tunnel off on B, use **Settings → Sharing & access → Preview tunnel** there. See [remote-access.md](../user/remote-access.md#localhost-on-a-remote-environment).

## 8. Phones: Android and iPhone

### What each one needs

|                            | Android                                                                                          | iPhone                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Install                    | Download the APK from [Releases](https://github.com/SimpleEve/t3-extend/releases)                | No download. Build it on a Mac with your own Apple account; needs macOS 26.6+ and Xcode 27.1+                                         |
| Connect                    | Any method in sections 4 to 6: LAN pairing, Tailscale, or your own server                        | The same. The first time it connects over the LAN, iOS asks for Local Network access; allow it                                        |
| Join your own server       | Settings → Your server, scan or paste the invite                                                 | The same                                                                                                                              |
| Push path                  | host → your ntfy server → the ntfy app on the phone → T3 Extend                                  | host → Apple's APNs → iPhone, with nothing in between                                                                                 |
| What push needs            | An ntfy server at a public address (your own server installs one), and the ntfy app on the phone | An APNs key (`.p8`) from a paid Apple Developer account, set up on **every** host. A build signed with a free account cannot get push |
| Push and connection method | The host must reach the public ntfy server                                                       | The host must reach Apple (`api.push.apple.com` and `api.sandbox.push.apple.com`), whichever way the phone connects                   |
| Background limits          | Some systems need "Allow full background activity" for ntfy and T3 Extend                        | Nothing to set                                                                                                                        |
| How long an install lasts  | Indefinitely                                                                                     | A year for a paid-account build, 7 days for a free one; then build and install again                                                  |

Both phones only get alerts from the environments they are connected to, and each environment pushes only its own threads. A thread you are looking at does not alert. A completion alert waits a short while to make sure there is no follow-up. Removing an environment, turning it off, or revoking this phone's session stops alerts from it.

### Android push

The T3 Extend Android app can receive alerts without T3 Connect, Firebase, or Google Play services, through UnifiedPush and your own ntfy server. The host encrypts each alert and sends it to your ntfy server. The ntfy app on the phone receives the encrypted data and hands it to T3 Extend, which decrypts it and shows it in the phone's current interface language. The ntfy server only handles encrypted data.

1. **An ntfy server at a public address.** The `setup.sh` in the Your own server section installs one by default, at `https://ntfy.t3.example.com`. The host only pushes to public addresses. Push servers on the LAN, on this computer, or on a tailnet are refused, and so are domains that resolve to those addresses.
2. **Find the push server's address and account.** On the VPS, in the `infra/self-host` directory, run `./t3x ntfy`. It shows the server address and the account for the phone (`phone`) and its password. For a server installed with `--no-ntfy`, it tells you that ntfy is not installed.
3. **The push app on the phone.** Install **ntfy** from F-Droid, open it, set the default server in its settings to the address above, and sign in with the `phone` account.
4. **Turn it on in T3 Extend.** Open Settings → Notifications, turn on Push notifications, and allow notifications. If only one push app is installed, it is chosen automatically; if you have several, pick one. After the push server answers, the page shows the push app and the server's hostname, and under each environment whether this phone has registered. Tap Send test notification under an environment; one should arrive within a few seconds.

Good to know:

- If an environment shows "not registered", the text after it gives the reason (could not connect, no answer, or registration refused). For could not connect and no answer, it retries on its own. For a refusal, turn Push notifications off and on again.
- Force stopping the app in system settings pauses push until you open it again.
- Some Android systems (for example ColorOS from OPPO) cut off a push app's connection once it leaves the screen. In system Settings → Apps, find ntfy and then T3 Extend, open Battery management, and choose "Allow full background activity".

For the full description, see [Push without Google](../user/mobile-notifications.md#push-without-google) in the upstream docs.

### iPhone push

iPhone notifications can only go through Apple's APNs, and only the Apple account that signed the app can send to it. T3 Extend has no relay: each host sends alerts to Apple directly, with a key from your own account.

1. **Create an APNs key.** In the paid Apple Developer account you built the app with, open Certificates, Identifiers & Profiles → Keys and create a key with Apple Push Notifications service (APNs) enabled. Download the `.p8` file (Apple lets you do this once) and note its Key ID. Creating keys needs the Admin or Account Holder role.
2. **Set it up on every host.** Put the `.p8` somewhere on the host that only you can read (for example `~/.config/t3extend/apns/`, mode 600), and add three lines to `~/.t3extend/service.env`:

   ```dotenv
   T3EXTEND_APNS_KEY_FILE=/Users/you/.config/t3extend/apns/AuthKey_XXXXXXXXXX.p8
   T3EXTEND_APNS_KEY_ID=XXXXXXXXXX
   T3EXTEND_APNS_TEAM_ID=<team ID>
   ```

   The team ID is shown in Xcode → Settings → Accounts; use the team you built with. Both the background service and the desktop app read this file. After changing it, run `t3x service restart` or reopen the desktop app. With none of the three set, iPhone push is off. With only some set, or a value that does not work, the server logs one warning saying why.

3. **Turn it on on the iPhone.** Open Settings → Notifications, turn on Push notifications, and allow notifications. Each environment shows whether the phone has registered. Tap Send test notification; one should arrive within a few seconds.

Good to know:

- "Not registered: this server has no APNs key" means that host is missing the three lines above, or has not restarted since. "Update this server to get push on iPhone" means that host runs an older version; run `t3x update` there.
- Right after the app opens, an environment that has not connected yet shows "Waiting for the connection…", and registers within seconds of connecting. If it keeps waiting, swipe the app away and open it again.
- The key can send any notification to your app. Keep it out of repositories, screenshots, and chats.

## 9. Troubleshooting

**First, check on the host that the server is running**: the desktop app is open, or `t3x service status` shows the service running. If the computer sleeps, shuts down, or goes offline, no connection method can reach it.

| Symptom                                                                                       | Look here first                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A phone or another computer cannot connect with the pairing link                              | If the address in the link is `127.0.0.1`, only this computer can use it. Create the link again with an address the other device can reach. On a LAN, turn on Network access (or `--lan`) on the host first.                                                                                          |
| The pairing code is refused, or the server returns 429                                        | A one-time code stops working once used. Make a new one. If one client address fails 20 times in 1 minute, it is locked out for 60 seconds.                                                                                                                                                           |
| Your own server: `curl https://t3.example.com/v1/info` gives a certificate error or times out | Check that both DNS records are live and that 80/443 are reachable from outside. For a server in mainland China, also check that the domain is filed. Then run `docker compose logs caddy` in the `infra/self-host` directory.                                                                        |
| Your own server: Caddy will not start and the log says `address already in use`               | Another service (such as nginx) is still using 80 or 443. Stop it, or let Caddy take over by following the "this VPS already has other websites" section.                                                                                                                                             |
| The desktop app says it cannot reach your server                                              | On that computer, run `curl https://t3.example.com/v1/info`. Then run `./t3x info` on the VPS. The settings page shows the message after 3 minutes without a sync.                                                                                                                                    |
| A newly joined device shows "Waiting for that computer to confirm…"                           | This is normal. The other computer syncs the device list once a minute, so it can take a minute or two. If it never changes, check that the other computer's server is running and can reach the server.                                                                                              |
| Tunnels drop for a few seconds now and then                                                   | Reloading or restarting Caddy or frps drops all tunnels for a few seconds, and they reconnect on their own. You do not need to join again.                                                                                                                                                            |
| A removed computer is still connected                                                         | It missed the removal while offline. It is revoked once it reconnects to the server.                                                                                                                                                                                                                  |
| `*.ts.net` names do not resolve (`ping` or `curl` says the host is unknown)                   | MagicDNS can be on for the tailnet while this machine is not hooked up to it. On macOS, a Homebrew `tailscaled` needs `/etc/resolver/ts.net` added by hand; see "Before you start" in section 5. `dig @100.100.100.100 <machine>.<tailnet>.ts.net` checks that Tailscale itself can resolve the name. |
| The Tailscale HTTPS route shows as connected but never answers                                | Is the server listening only on the tailnet address because of `--host <tailnet IP>`? Go back to the default local address, then turn Tailscale HTTPS on again.                                                                                                                                       |
| Tailscale HTTPS will not turn on                                                              | Check that MagicDNS and HTTPS certificates are on for the tailnet. On Linux, check operator permission. If the port is taken, use `--tailscale-serve-port` to pick another. Do not use 443.                                                                                                           |
| The Keep running in the background row says there is a problem with the app location          | You moved or deleted the app, or opened it straight from the disk image. Put the app in Applications, then turn the switch off and on.                                                                                                                                                                |
| On opening the app it says the background service could not be stopped, then quits            | The app will not start a second server while the service still holds the data. Run `t3x service uninstall` to remove the service.                                                                                                                                                                     |
| `t3x service install` fails to download                                                       | The release it needs is missing or the network blocks GitHub. Check that the version exists on the Releases page, or set `T3CODE_RELEASE_BASE_URL` to your own mirror. On macOS you can also use the desktop app's switch, which downloads nothing.                                                   |
| localhost does not open in a remote environment's tab                                         | Check that the service listens on `127.0.0.1` (or `::1`) on the environment, and that **Preview tunnel** is on under Settings → Sharing & access there. The T3 server's own port is never forwarded.                                                                                                  |
| The phone gets no push                                                                        | In Settings → Notifications, use Send test notification first. Then check that the push server is at a public address, that the server and account in the ntfy app are right, and that the phone is not limiting ntfy in the background.                                                              |

The usual order when troubleshooting is: is the host's server running, can the other side reach the address, and has the credential expired or been revoked. The upstream [Remote access](../user/remote-access.md) and [background service](../user/background-service.md) docs have more detail. For problems with the self-hosted server itself, see ["出问题时" (when something goes wrong) in infra/self-host/README.md](../../infra/self-host/README.md#出问题时).

## Interface names in Simplified Chinese

The body of this guide uses the English interface names. If you use the Simplified Chinese interface, these are the matching names.

| English interface              | Simplified Chinese interface |
| ------------------------------ | ---------------------------- |
| Sharing & access               | 共享与访问                   |
| Your server                    | 你的服务器                   |
| Join my server                 | 加入我的服务器               |
| Invite a device                | 邀请设备                     |
| Leave this server              | 退出此服务器                 |
| Remove                         | 移除                         |
| Network access                 | 网络访问                     |
| Authorized clients             | 已授权的客户端               |
| Create link                    | 创建链接                     |
| Revoke                         | 撤销                         |
| Environments                   | 环境                         |
| Add environment                | 添加环境                     |
| Keep running in the background | 在后台保持运行               |
| Maintenance                    | 维护                         |
| Browser                        | 浏览器                       |
| Local servers                  | 本地服务                     |
| Scan QR code                   | 扫描二维码                   |
| Paste invite                   | 粘贴邀请                     |
| Notifications                  | 通知                         |
| Push notifications             | 推送通知                     |
| Send test notification         | 发送测试通知                 |
| About                          | 关于                         |
