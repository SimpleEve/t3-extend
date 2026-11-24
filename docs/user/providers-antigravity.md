# Antigravity

T3 Code runs Google's official Antigravity ACP agent on your selected environment.
T3 manages its own CLI installation, separate from your terminal or IDE. The default instance uses
the same Google sign-in as the `agy` CLI on that machine, and other instances sign in on their own
(see [Use your agy CLI sign-in](#use-your-agy-cli-sign-in)). Google controls which models and
account access are available through this agent.

## Set up Antigravity

On web or desktop, open **Settings > Providers**, choose the environment that runs
your project, and enable Antigravity. Install its runtime there, then choose
**Sign in** and complete the browser sign-in. Wait for T3 Code to confirm
account access and load models before starting a thread. Once the runtime is installed,
you can also sign in from **Settings > Providers** in the mobile app.

If you already signed in with `agy` in a terminal on that machine, you do not need this step: the
default instance picks that sign-in up by itself.

Installation continues if you leave settings or reconnect. Setup requires
permission to operate the environment; update an older server if it does not offer
Antigravity setup.

### Sign in from a remote device

Google finishes on an Antigravity page that shows a code. Paste that code, or the
page's full address, into the code field in the client where you started sign-in.
This works the same from any device.

The code is temporary. Paste it only into the setup field. The page alone does not
confirm account access; wait for T3 Code's confirmation.

### Other sign-in methods

Choose **Sign-in method** in the Antigravity provider settings:

| Method                     | Credentials                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Google account             | Personal Google sign-in in the browser                                                       |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                                               |
| Gemini API key             | API key; choose Connect without a browser                                                    |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials on the environment |

The environment stores the Antigravity API key outside its settings file, and
clients only see whether one is saved. The agent uses the method and credentials selected for this instance;
ambient `GEMINI_API_KEY` and Google credential variables do not override them.
Changing the method stops the instance's sessions. Sign out before replacing an
account.

## Runtime installation

Managed installation supports Apple Silicon and Intel macOS, Linux x64 or ARM64
with glibc or musl, and Windows x64 or ARM64. Allow at least 1.25 GiB of free disk
space for downloading and staging an update.

### Use a manual installation

Install [Antigravity CLI](https://antigravity.google/docs/getting-started) on the environment.
Set **Binary path** to its `agy` executable and update it yourself.
Leave the field blank to use the managed runtime, or a compatible executable on
`PATH` if no managed runtime is installed.

## Update the managed runtime

In web or desktop provider settings, choose **Update Antigravity** when an update
is available. T3 checks Google's CLI release channel while provider update checks
are enabled. Installing or reinstalling also checks that channel. Updates keep
your profile and existing runtime available if the new release fails validation.

T3 needs Antigravity 1.5 or newer and recommends 1.5.12 or newer. Sessions do not
start on an older runtime: update the managed runtime here, or update the executable
a custom binary path or `PATH` points at. You may need to sign in again after
updating from a runtime older than 1.5. Threads already running finish with their
original runtime; new sessions use the updated release. Custom binary paths keep
using the executable you selected.

## Models and threads

The model list comes from your Antigravity account, including Claude and GPT models
when your plan has them. Pick a thinking level beside the model list in the model picker; it
shows only the levels the selected model supports. A resumed thread keeps its
selected model. If access to that model ends, select another available model
before continuing.

Antigravity creates empty `.gemini/skills` and `.agents/skills` folders in the
workspace when a session starts. Git does not track empty folders, so they never
appear in commits.

Use Antigravity's native `/plan` command for planning. Tool approvals follow [Permission modes](./permission-modes.md).
Questions with fixed choices still need one of the offered answers, even in
**Full access**.

On web and desktop, [Edit from here](./composer.md#edit-an-earlier-prompt) works with
Antigravity. Antigravity cannot rewind its own conversation, so the next turn
starts a fresh Antigravity session and T3 Code sends it the kept conversation,
without the turns you removed.

Use `/compact` to summarize a long conversation when your Antigravity runtime
offers that command. If it is unavailable, update Antigravity in provider settings
or send `/clear` when you need a fresh context.

### Skills and attachments

Put project skills in `.agents/skills`. T3 Code also reads `.gemini/skills` and the
legacy `.agent/skills` directory. Among these project locations, the first copy
wins in this order: `.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Skills for every project go in `~/.gemini/config/skills` or
`~/.gemini/antigravity-cli/skills`. Antigravity does not read `~/.agents/skills`
on its own; to share a folder like that one, list it in `~/.gemini/config/skills.json`
(or a project's `.agents/skills.json`), and T3 Code shows the skills it declares,
honoring `inherits`, `include_only`, and `exclude`.

Antigravity receives images and audio directly, and reads PDFs and text files as
documents. Other attachments, including videos, are passed as a saved file path for
the agent to inspect with its tools.

### Subagents

Antigravity groups subagent activity into batches. Open a batch and select
**Subagent work** (**Work** on mobile) to read each child's role, prompt, and recent steps. This view
is read only: you cannot message or control individual subagents, and an idle
batch does not confirm that every child succeeded. If Antigravity did not record
which children a batch started, the view says so. See
[agent work](./thread-sidebar.md#inspect-agent-work) for where to inspect
activity.

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
  does not read. Choose **Separate sign-in** to see Antigravity limits.
- Signing in from T3 while the CLI is signed out can also sign the CLI in, because both use one sign-in.

## Accounts and removal

Add an Antigravity provider instance for each Google account in
**Settings > Providers** on web or desktop. Each has its own sign-in; downloaded
runtimes are shared on the environment.

| Action                    | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| Disable                   | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out                  | Stops the instance's sessions and removes its saved Google login. |
| Remove downloaded runtime | Removes the shared installation and keeps Google credentials.     |

All three keep thread history and workspace files. Sending `/logout` by itself in
a thread signs out its instance, including stopping that instance's other sessions.
That needs a client allowed to manage providers, and it has to be your own message:
`/logout` from an agent or a scheduled task is refused.
Sign out, then sign in again to replace an account.

Before removing a managed runtime, disable its instances and cancel any active
installation. Clear any explicit binary path pointing into that runtime. Removal
is refused while the runtime is in use.

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
a single turn switches at most eight times. With the setting off, nothing changes.

**Usage > Limits** shows the account in use live and every other saved account as its last
reading, with how old it is. Google can reset quota early, and a saved account's sign-in goes stale
about an hour after it stops being used, so by default T3 reads one saved account that is not in use
about every 45 minutes. While its saved sign-in is still good the quota is read with it directly.
Once it has expired T3 starts agy briefly on a private copy of it to renew it, sends no prompt, so no
quota is used, and never touches the account in use. Turn off **Check other accounts in the
background** to stop this. The refresh button next to an account, or next to **All accounts**, reads
on demand whatever that setting says; leaving the page while it runs stops it without counting as a
failure. If a read fails the old reading stays, and the row says why; a sign-in Google no longer
accepts needs the account to sign in again, and is not tried again for hours. T3 lifts an
out-of-quota mark early only when a new reading shows every window the account had, all with quota.

Rotating between accounts to get more quota may break Google's terms. That is your decision and
your risk. Accounts on one machine still share its network address; see
[Send Antigravity traffic through a proxy](#send-antigravity-traffic-through-a-proxy).

## Send Antigravity traffic through a proxy

Set **Network proxy** in the instance's settings to `http://`, `https://`, `socks5://`, or
`socks5h://` followed by a host and port, such as `http://127.0.0.1:7890`. Credentials can go in
the URL, and are saved as plain settings. The one proxy covers everything the instance sends to
Google: the agent, and the quota requests behind **Usage > Limits**. Loopback addresses are never
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
removes that server's sign-in from the file. Sign in to that server again in the terminal. Other
servers' sign-ins are not touched, and servers whose refresh tokens stay valid are not affected.

While the global MCP configuration lists any server, even a disabled one, Antigravity does not write
titles or commit messages for that instance. Choose another model for them.

## Run a native goal

When your Antigravity runtime offers `/goal`, send `/goal` followed by a verifiable
objective. Antigravity keeps working until it completes the goal or you cancel it.

Use Stop to interrupt a running goal, then ask Antigravity to stop pursuing it
before starting more work. Ordinary follow-ups wait until the running turn ends.
T3 does not support Antigravity goal status, pause, resume, or clear commands.

## Check access and troubleshoot

Open **Usage > Limits** to see the remaining Gemini and shared Claude/GPT allowances
for Google sign-ins. Each group has separate five-hour and weekly limits and reset
times. Limits refresh with provider status and include usage outside T3 Code.

A server restart keeps your Google sign-in. The provider shows the saved account
until a session, a refresh, or a sign-out reports something new.

To check access and reload models, use **Refresh provider status** in web or desktop
provider settings, or **Refresh models** in mobile thread settings. If asked to
sign in again, use provider settings on web or desktop, or **Settings > Providers** on mobile.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit,
follow the provider's message and any retry time. See [Google's account plans][plans]
for eligibility.

[plans]: https://antigravity.google/docs/plans
