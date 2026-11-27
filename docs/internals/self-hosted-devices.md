# Self-hosted devices

T3 Extend only. This page records why the "Your own server" feature
([user guide](../user/remote-access.md#your-own-server)) is built the way it is.
The full design, with the measurements behind each choice, is
`research/self-host-device-keys.md`; the code lives under `fork/deviceKeys/`
directories in the server, client runtime, web and mobile apps.

## A pass, not a challenge

A phone or computer proves itself to a computer by presenting a short-lived
signed pass (an RFC 7523 JWT-bearer assertion) that names the computer's
environment id and the DPoP key the session will be bound to. The computer
exchanges it for an ordinary DPoP session at its own `POST` token route, which
runs through the same DPoP verification, response headers, CORS and rate limit
as `/oauth/token`.

A challenge-response would cost a round trip to a computer that may be behind a
slow tunnel, and it needs the computer to hold per-attempt state. The pass needs
neither, and the audience is an environment id rather than a URL, so the same
pass works over the tunnel, a LAN address or a tailnet address. A pass is spent
by its first use (replay markers share `auth/replayMarkers.ts`). The session
lasts an hour and is revoked when the sync no longer lists the device. A removal
made in this process closes the device's sockets at once. One made by another
process (the CLI's `devices remove` and `leave`, or `auth session revoke`)
writes the database directly, so the running server learns of it only when its
next sync ends, up to a minute later, and the old socket keeps working until
then. Every sync therefore ends by checking the live sockets' sessions, joined
or not, and a failure of that check never fails the sync.

## Why `t3x-device` is a separate authorization, and why it fails closed

A device-managed environment must never be signed in through the official relay
or with a Bearer token: that would send a self-hosted computer's credentials to
a service the user chose not to use. So connection profiles get their own
`authorization: "t3x-device"`, and every failure of it (missing key, corrupt
data, unreachable registry, an unknown device) blocks the connection instead of
falling back.

Two independent guards enforce that:

1. **Stamping.** Only the [resolver](../../packages/client-runtime/src/connection/resolver.ts)
   marks a prepared connection with `authorizer: "t3x-device"`. Renewal and the
   HTTP signer branch on that mark. `staticGuard.test.ts` fixes the set of files
   allowed to call the relay authorization functions, so a new call site fails
   the test.
2. **The device index.** Relay authorization asks `DeviceEnvironmentIndex`
   whether an environment is a device environment and refuses if it is. The
   index keeps no state of its own: it reads the saved-connection catalog on
   every call, so an environment restored after a restart or registered a moment
   ago is recognised without waiting for a sync. The catalog is bound before any
   connection can start. In the web and mobile runtimes the index starts with
   `failClosedUntilBound`: until a catalog is bound, relay authorization refuses
   every environment, so a missed stamp or a race at startup can only block.

Sessions are also tagged with the subject `t3x-device:<kind>:<device id>`, which
is how the server tells a device session from a pairing browser.

## Trust boundary

The VPS is the source of truth for the device list, and clients pin its identity
the first time they join. Anyone who controls the registry (or the domain) can
add a key of their own to the list, and HTTPS ends on the VPS, so it can also
read traffic. The feature is for a server only the user controls. Three
hardenings are deliberately not built yet: computers terminating TLS
themselves, a device list signed by the user's own devices, and
non-exportable phone keys.

What a session can do is bounded by scope, not by the operating system:

- Phone sessions get the standard client scopes without `access:write` and
  `relay:write`. A phone can use the environment but cannot invite or remove
  devices or mint relay tokens, and the registry independently refuses phone
  invites and removals.
- Only the desktop app's own bootstrap session may call `devices.*`. Pairing
  browsers and device sessions are refused whatever scopes they hold.
- A session with `terminal:operate` is a shell as the server's OS user. It can
  read this computer's device key and impersonate the computer until it is
  removed. Nothing here prevents that; the mitigation is to remove the computer
  quickly. The `access:write` restriction on phones protects against a
  misled client, not against a hostile one.

## Hiding a computer: the computer decides, the registry only hides

A computer's visibility setting is judged twice, and only one of them is a security boundary.
The computer refuses a pass from a device its own saved setting excludes (`device_hidden`),
reading the file on every pass rather than trusting its in-memory copy, so a change made by the
CLI in another process counts at once. An unreadable file refuses every pass, but that guess is
not the user's setting: it is not stored as one, not pushed to the registry, and the status says
`unreadable` (the last value that could be read stays on show) so the page does not claim "hidden
from all".
The registry filters `GET /v1/devices` per viewer, which only makes a hidden computer vanish from
that device's list like a removed one. A registry that is old, unreachable or wrong cannot let a
device in, and it cannot delete a key: the hidden device's own entry is always in its list, so
the "no longer a member" path is never taken.

Hiding is one-way, and that is why the filtered list is not enough. A computer A that hides from
B must still sign in to B, so B has to check A's pass against A's key. The registry therefore
sends B A's identity (id, kind, public key, nothing else) in `hiddenPeers`. A hidden peer is not
in `devices`, so it never becomes a listed device or an environment; B keeps its sessions, and
treats its pass like any other. Only computers get `hiddenPeers`: a phone never checks a pass.

The failure to know about is the opposite of what one might guess. A computer X that predates
the field does not know `hiddenPeers`: when A hides from X, X's next sync sees A missing from its
list, revokes A's sessions and no longer finds A's key, so **A cannot connect to X** until X is
updated. X still cannot see A, so "hidden must not see" holds. The registry does not detect old
clients and send them the full list, because that would let exactly the device meant to be blind
see the computer. The user guide tells people to update the computers they hide from, and the
dialog says so.

Names and subdomains are unique across the whole group, so a hidden device that renames itself (or
joins) to a name that is taken learns by the 409 that some computer it cannot see has it. That
cannot be closed without giving up uniqueness; it is accepted. Invite lists and invite cancels
follow the same visibility as everything else (a hidden viewer neither sees nor cancels a hidden
computer's invites, and gets the same 404 as for an invite that does not exist). The registry's `rev`
counts the whole registry, so it still moves when a hidden computer changes; that is recorded, not hidden.

The setting is pushed to the registry afterwards and compared on every sync (a computer's own
entry carries it back). An answer without it means the registry is too old, and the page says so;
the local setting still applies. Delivery is not under the gate, so a push that finishes after the
setting changed is repeated rather than reported as synced. What the registry said is kept in a file
beside the setting, stamped with the value it is about, so the CLI's next process can report it.

The CLI never syncs from its own process: a second sync beside the running server has its own gate
and could delete the device key (see below). So `visibility hide|only <name>` resolves names from
the last synced list, and a device that joined after it has to be named by its id or wait for the
running server's sync; the error says so.

## The tunnel listener and `X-T3x-Client-IP`

frpc forwards to a second HTTP listener bound to `127.0.0.1` on a system-chosen
port, not to the main port. frps rewrites `X-Forwarded-Proto` to `http` and
appends its own hop to `X-Forwarded-For`, so the main listener cannot work out
the public origin or the client address from a tunnelled request. The tunnel
listener's middleware replaces `Host` and the protocol with the computer's own
public address and sets the client address from the `X-T3x-Client-IP` header
that Caddy overwrites on every request.

That header is trusted only on the tunnel listener. The main listener ignores
it, because anyone who can reach that port could otherwise pick their own rate
limit bucket. The rule is the same for the registry, which limits only on the
Caddy-written header.

## The device list is fetched in full every time

`GET /v1/devices` always returns the whole list the asker may see (see
[Hiding a computer](#hiding-a-computer-the-computer-decides-the-registry-only-hides); `rev` still counts
membership and setting changes for the whole registry, not per viewer). A conditional request keyed on
`rev` would be wrong: `online` and `lastSeenAt` change with time while `rev`
only changes when membership does, so a computer would show itself and its
peers as offline until a device was added or removed. A successful sync always
publishes a snapshot, and the UI uses the snapshot's state directly.

`t3x devices list` reads the saved list and never syncs. A sync from a second
process would run beside the server's own with a different lock, and a
registry answer of "unknown device" makes a sync delete the device key.

## frpc lives in its own process group

On macOS and Linux frpc is started under `/bin/sh` in its own process group,
with a small watcher that holds a pipe the server keeps open. If the server
dies, even by `SIGKILL`, the pipe closes and the watcher stops the whole group.
Cleaning up at startup from a PID file was rejected: a recorded PID can belong
to an unrelated process by the time it is used, and killing by recorded PID is
exactly the mistake this repository warns against. Windows has no process
groups, so there a killed server can leave frpc running; that is a known limit.

The server also never trusts what frpc prints beyond four exact sentences
carrying the registry's `t3x:` reasons. Truncated, non-UTF-8 or unknown text is
shown but never acted on.
