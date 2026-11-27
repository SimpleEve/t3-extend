# Usage and limits

Track token usage, cache hit rates, estimated API-equivalent costs, and pooled subscription quotas across all connected environments.

- **Open Usage**: Click **Usage** in the sidebar, press `mod+u` (web/desktop outside terminals), or pick **Usage** on mobile.
- **Quick shortcuts** (web/desktop on Usage): `C` (Cost), `T` (Tokens), `L` (Limits), `mod+Shift+1/2/3/4` (24h / 7d / 30d / 90d), `Esc` (back).

## Understand your usage

Usage aggregates history across Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor from your selected environments. Estimates reflect API-equivalent rates (not your subscription bill); **Premium** shows Fast/Ultrafast surcharge, and **Other** shows unsplit provider-reported costs.

- **Retention**: Servers keep scanned usage history for **92 days** by default (preserving Claude history after Claude's 30-day cleanup). Change `usageHistoryRetentionDays` in `<t3-home>/userdata/settings.json` (e.g. `365` or `"unlimited"`; views show up to 90 days).
- **Custom data directories**: Honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, `OPENCODE_DATA_DIR`, `ANTIGRAVITY_DATA_DIR`, and `XDG_DATA_HOME` (Muse). Use absolute or `~/` paths. Set `T3CODE_HOST_ID` to pin a container's host identity.
- **Exclusions**: Codex and Claude Code 2.0.63+ text-generation runs (titles, commits, PR text, review guides) and Grok turns without a saved completed-turn record are not included.

## Custom model prices and filtering

- **Custom prices & model mapping**: Open the environment dropdown on **Usage → Model prices** (or click **Set price** on an unpriced model) to set USD per million input/output/cache tokens, or set **Map to** to merge a preview/alias model ID into a target model's totals.
- **Filter models**: Add `usageModelFilter` to `<t3-home>/userdata/settings.json` (applied before **Map to**):

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

## Subscription limits

**Usage → Limits** pools subscription quotas per provider across connected environments and hubs (deduplicating the same account signed in on multiple machines).

- **In chat**: Run `/usage-limits` in the composer to view the current model's snapshot without running the agent, or enable **Settings → Appearance → Thread details → Usage limits** (web/desktop).
- **Reset credits**: Click an account segment/row to inspect plan details and redeem banked Codex/Claude reset credits via **Use reset** (Claude resets unavailable on macOS Keychain logins).
- **Provider notes**:
  - **OpenCode**: OpenCode 2 servers with usage reporting show Go allowances and Console budgets for the connected workspace. Local servers can also report Go usage from a Go API key (`OPENCODE_API_KEY`).
  - **Cursor**: Reports monthly Auto + API quotas via `CURSOR_AUTH_TOKEN` or default-endpoint sign-in/`CURSOR_API_KEY`.
  - **Grok**: Reports billing-period quotas for `grok login` (not `XAI_API_KEY`).
  - **Muse Code**: Reports session/weekly limits after running in a thread (not persisted across restarts).
  - Pure API-key accounts generally do not report subscription limits.
  - **Antigravity** (T3 Extend): Quota is not read unless you turn on **Read quota from Google** in the instance's settings, because it calls Google's internal cloudcode-pa API and Google says that can get an account flagged (use at your own risk). Until then Usage shows no Antigravity limits and your accounts' quotas are not listed, as in upstream T3 Code; switching accounts when a turn runs out of quota still works. With it on, an instance that keeps several Google accounts lists them one row each instead of segments: the **All accounts** row first, then the account in use (marked **Current**), then the rest by when their quota returns. Only the account in use can be read live, so the others show their last reading with "read 3h ago". A window whose reset has passed counts as refilled, an out-of-quota account shows 0% until it is back, and a reading older than half an hour loses its pace marks and says it may be out of date. A reading is taken whenever an account is in use, so an account you have not used since adding it shows "No reading yet".
- **Context ring and speed** (T3 Extend): The ring beside the composer's send button always shows how full the context window is. Select it to see the numbers, the point where the provider compacts on its own, the speed of the last turn, and a **Compact now** button, which sends the same `/compact` you could type. The tokens-per-second figure beside it is approximate: it divides the output the provider reported for that turn by the time spent writing, not running tools, and it appears only for providers that report output per turn.
- **Mobile widget**: Add the **Subscription usage** widget on iOS or Android to monitor Codex and Claude quotas from your home screen.

## Connect a CLIProxyAPI hub

Open **Settings → Providers → Usage providers → Add hub**, choose the environment, and enter the hub URL and management key. Pools Codex, Claude, and Grok accounts under **Usage → Limits** (including Codex **Use reset**). Configure the provider's endpoint to the same URL if you want threads to display that hub's limits.

## Connect an HTTP quota source

Open **Settings → Providers → Usage providers → Add HTTP source** with a GET endpoint (and optional bearer token) returning:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "primary",
      "label": "My coding plan",
      "providerInstanceId": "work-codex",
      "windows": [
        {
          "id": "monthly",
          "kind": "monthly",
          "label": "Monthly budget",
          "usedPercent": 35,
          "resetsAt": "2026-12-01T00:00:00Z"
        }
      ]
    }
  ]
}
```

`kind` is `session`, `weekly`, `monthly`, or `other`. Setting `providerInstanceId` binds the quota windows to that instance's thread details card.
