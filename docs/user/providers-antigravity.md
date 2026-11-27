# Antigravity

T3 Code runs Google's official Antigravity ACP agent on your selected environment.
T3 manages its own CLI installation, separate from your terminal or IDE. The default instance uses
the same Google sign-in as the `agy` CLI on that machine, and other instances sign in on their own
(see [Use your agy CLI sign-in](#use-your-agy-cli-sign-in)). Google controls which models and
account access are available through this agent.

## Set up Antigravity

1. Open **Settings → Providers** (web or desktop), choose your environment, and enable **Antigravity**.
2. Install the managed runtime (requires 1.25+ GiB free disk space; supports macOS Apple Silicon/Intel, Linux x64/ARM64 glibc/musl, and Windows x64/ARM64).
3. Click **Sign in** and complete browser sign-in. Wait for T3 Code to confirm access and load models. (Once installed, you can also sign in from mobile.)

- **Remote sign-in**: Paste the temporary code (or full URL) from Google's completion page into T3 Code's code field.
- **Manual binary**: Install [Antigravity CLI](https://antigravity.google/docs/getting-started) and set **Binary path** to `agy`. Leave blank to use the managed runtime (or `PATH`).
- **Updates**: Click **Update Antigravity** in provider settings. T3 Code requires Antigravity **1.5.1+** (1.5.12+ recommended); running threads finish on their original runtime.

If you already signed in with `agy` in a terminal on that machine, you do not need this step: the
default instance picks that sign-in up by itself.

### Sign-in methods

Choose **Sign-in method** in the Antigravity instance settings:

| Method                         | Credentials                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Google account**             | Personal Google browser sign-in                                         |
| **Gemini Enterprise**          | Browser sign-in, GCP project, and GCP location                          |
| **Gemini API key**             | API key (no browser required)                                           |
| **Agent Platform / Vertex AI** | API key, or GCP project + location with Application Default Credentials |

API keys are stored outside `settings.json`, and ambient `GEMINI_API_KEY` / Google env vars do not override the instance's configured method.

## Models, planning, and goals

- Models (including Claude and GPT when included in your plan) and thinking levels come from your Antigravity account.
- Use `/plan` for planning, `/compact` to summarize (if supported by your runtime), or `/clear` for a fresh session.
- **Edit from here** starts a fresh Antigravity session with the kept conversation history.
- **Native goals**: Send `/goal <objective>` when supported by your runtime. Use **Stop** to interrupt, then tell Antigravity to stop pursuing it before starting new work (`pause`/`resume`/`clear` are not supported).
- **Subagents**: Batched subagent activity is inspectable read-only via **Subagent work** (**Work** on mobile).
- Antigravity creates empty `.gemini/skills` and `.agents/skills` directories in workspaces on start (untracked by Git).

### Skills and attachments

- **Project skills**: Loaded in priority order from `.gemini/skills`, `.agents/skills`, then `.agent/skills`.
- **Global skills**: Loaded from `~/.gemini/config/skills` or `~/.gemini/antigravity-cli/skills` (list `~/.agents/skills` in `~/.gemini/config/skills.json` or `.agents/skills.json` to include it).
- **Attachments**: Images and audio go directly to the model; PDFs and text files load as documents; videos and other files pass a saved file path (supported videos go natively to Gemini models).

## Multiple accounts and removal

Add a separate Antigravity instance in **Settings → Providers** for each Google account (runtimes are shared on disk).

| Action                              | Effect                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| **Disable**                         | Stops sessions; keeps saved login and history.                          |
| **Sign out** (or `/logout` in chat) | Stops sessions and removes saved login; keeps history.                  |
| **Remove downloaded runtime**       | Deletes shared runtime after instances are disabled; keeps credentials. |

### Keep several Google accounts in one instance

An instance that signs in on its own (**Login source** set to **Separate sign-in**, Google account
method) can keep more than one Google account. Choose **Change account** and finish the Google
sign-in: the account that was in use stays saved, and the new one becomes the one in use.
Signing in again with an email you already saved refreshes that account instead of adding a copy.

Saved accounts are listed under **Account** in the instance's settings on web, desktop, and mobile.
**Use** makes one the account new turns run on, and **Remove** deletes it. Both stop the instance's
running threads first, because a running agent would otherwise write its own account back. **Sign
out** removes every saved account. Accounts only join through Google's own sign-in; T3 does not
import them from anywhere else. The tokens stay in the instance's profile.

Turn on **Switch accounts when quota runs out** to let T3 move on by itself. When a turn hits its
usage limit, T3 marks that account as out of quota until its reset time, starts the agent on the
next saved account that still has quota, and sends the same message again in the same thread. The
thread shows a "Provider recovered" notice naming both accounts, with part of each email hidden.
If every saved account is out of quota the turn fails once and says when the first one resets, and
a single turn switches at most eight times. With the setting off, nothing changes. Switching works from the error the turn reports, not from a quota reading, so it needs no quota reading and works with **Read quota from Google** off too, taking the saved accounts in the order they are listed.

With [Read quota from Google](#antigravity-quota-is-not-read-by-default) on, **Usage > Limits**
shows the account in use live and every other saved account as its last
reading, with how old it is. Google can reset quota early, and a saved account's sign-in goes stale
about an hour after it stops being used, so by default T3 reads one saved account that is not in use
about every 45 minutes. While its saved sign-in is still good the quota is read with it directly.
Once it has expired T3 starts agy briefly on a private copy of it to renew it, sends no prompt, so no
quota is used, and never touches the account in use. Turn off **Update other accounts' quota
automatically** to stop this. The refresh button next to an account, or next to **All accounts**, reads
on demand whatever that setting says; leaving the page while it runs stops it without counting as a
failure. If a read fails the old reading stays, and the row says why; a sign-in Google no longer
accepts needs the account to sign in again, and is not tried again for hours. T3 lifts an
out-of-quota mark early only when a new reading shows every window the account had, all with quota.

Rotating between accounts to get more quota may break Google's terms. That is your decision and
your risk. Accounts on one machine still share its network address; see
[Send Antigravity traffic through a proxy](#send-antigravity-traffic-through-a-proxy).

## Use your agy CLI sign-in

The default Antigravity instance uses the Google sign-in of the `agy` CLI on the same machine. On a
machine where you have already run `agy`, enabling Antigravity needs no second sign-in. T3 asks the
agent whether that sign-in works when the provider is enabled, now and then while it is not signed
in, and again after 30 minutes without a confirmation, so signing out with `agy` shows up here
within about half an hour. **Refresh provider status** checks right away, for example after you sign
in from a terminal. **Sign in** also finishes at once, without a browser, when the CLI is already
signed in.

Only the sign-in is shared. Threads, hooks, MCP servers, and rules stay in T3's own profile, and
nothing in `~/.gemini` is changed, unless you turn on
[Use your own MCP servers](#use-your-own-mcp-servers), which shares the MCP sign-in file that
`agy` also writes.

Choose **Login source** in the Antigravity provider settings. It applies to Google account and
Gemini Enterprise sign-in:

| Login source     | Behavior                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic        | The default instance uses the agy CLI login. Other instances, and any instance that ever signed in on its own, keep a separate sign-in. |
| agy CLI login    | Use the agy CLI login, even for another instance or one that signed in on its own before.                                               |
| Separate sign-in | Keep a sign-in only T3 uses, for example to run another Google account next to the CLI's.                                               |

Automatic remembers a separate sign-in even after you sign out of it, so a restart never swaps that
account for the CLI's. Choose **agy CLI login** to switch it over on purpose. Instances imported
from official T3 Code start on **Separate sign-in**.

Limits of sharing the CLI sign-in:

- **Sign out**, and `/logout` in a thread, are unavailable for this instance, because signing out
  here would also sign out `agy` in your terminal. Sign out with `agy`, or switch **Login source**
  to **Separate sign-in**.
- **Usage > Limits** is empty for this instance. The sign-in sits in the system keyring, which T3
  does not read. Choose **Separate sign-in** and turn on
  [Read quota from Google](#antigravity-quota-is-not-read-by-default) to see Antigravity limits.
- Signing in from T3 while the CLI is signed out can also sign the CLI in, because both use one sign-in.

## Send Antigravity traffic through a proxy

Set **Network proxy** in the instance's settings to `http://`, `https://`, `socks5://`, or
`socks5h://` followed by a host and port, such as `http://127.0.0.1:7890`. Credentials can go in
the URL, and are saved as plain settings. The one proxy covers everything the instance sends to
Google: the agent, and the quota requests behind **Usage > Limits** when
[Read quota from Google](#antigravity-quota-is-not-read-by-default) is on. Loopback addresses are never
proxied. Leave it empty to use the machine's own network, including any proxy variables it already
has. A proxy that does not parse is reported as a configuration problem, and if the server cannot
use the proxy the limits show as unavailable instead of going out directly. SOCKS5 support for the
limit requests is Node's experimental one. The proxy is per instance, not per account.

## Use your own MCP servers

An instance has its own MCP configuration and MCP sign-ins, separate from the `agy` command's. To use
the ones you already have, add each server and sign in to it in a terminal with `agy`, then turn on
**Use global MCP servers** in the instance's settings. Each time Antigravity starts for the instance,
T3 copies `~/.gemini/config/mcp_config.json` into it, leaving out any server named `t3-code`, which
T3 supplies itself, and links the instance to the `agy` CLI's MCP sign-in file. The setting takes
effect the next time Antigravity starts for that instance. Turning it off removes the copy and the
link, and only those.

T3 cannot finish a first-time MCP sign-in itself, so authorize each server in the terminal first. A
server that cannot connect, or whose sign-in has expired, is skipped without failing the thread. If
the instance already has an MCP configuration or sign-ins of its own, they are kept, the global ones
are not used, and the server log says so. This is available on macOS and Linux only. Instances that
use the `agy` CLI sign-in as their login source are not verified for MCP sign-ins.

Every thread runs its own `agy` process, and the terminal `agy` is another. They all use the one MCP
sign-in file, and a process refreshes with the token it read when it started. When a server issues a
new refresh token each time, a process that did not do the refresh fails when it tries, and `agy`
removes that server's sign-in from the file. Sign in to that server again in the terminal, then
restart the instance's running Antigravity threads: older processes still hold the revoked token
and can delete the new sign-in. Other servers' sign-ins are not touched, and servers whose refresh
tokens stay valid are not affected.

While the global MCP configuration lists any server, even a disabled one, Antigravity does not write
titles or commit messages for that instance. Choose another model for them.

## Antigravity quota is not read by default

T3 Extend does not read your Google account's Antigravity allowances unless you ask it to. Reading
them calls Google's internal `cloudcode-pa` API, and Google says that can get an account flagged.
Upstream T3 Code stopped doing it for that reason. In T3 Extend it is a per-instance switch that is
off by default: turn on **Read quota from Google** in the Antigravity instance's settings, at your
own risk.

- **Off (default).** T3 sends no quota request for the instance: it does not read the account in use,
  it does not renew and read the other saved accounts in the background, and the **Refresh** buttons
  for accounts are gone. **Usage > Limits** shows no Antigravity allowances and no per-account rows,
  the same as upstream T3 Code. **Usage** still shows tokens and cost from Antigravity's local
  history. Switching accounts when a turn runs out of quota still works.
- **On.** The instance shows the Gemini and shared Claude/GPT allowances, with separate five-hour and
  weekly limits and their reset times, in **Usage > Limits**, as described under
  [Keep several Google accounts in one instance](#keep-several-google-accounts-in-one-instance).
  The setting **Update other accounts' quota automatically** only applies while this is on.

A CLIProxyAPI hub does not read Antigravity accounts' quota, whatever this setting says.

## Usage and troubleshooting

- T3 Extend does not read your Google account's Antigravity allowances unless you turn on [Read quota from Google](#antigravity-quota-is-not-read-by-default); **Usage** shows tokens and cost from Antigravity's local history.
- Use **Refresh provider status** (web/desktop) or **Refresh models** (mobile) to reload models and access.
- For `SUBSCRIPTION_REQUIRED` or account restriction errors, see [Google's account plans](https://antigravity.google/docs/plans).
