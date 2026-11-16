# omp

T3 Code can use your existing [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) installation while
keeping omp's models, accounts, skills, extensions, rules, memory, and native session history.
omp is a fork of Pi with its own tools and settings, so it is a separate provider from [Pi](./providers-pi.md).
You can also reach omp through the [ACP Registry](./providers-acp.md); this provider is the fuller
integration.

## Set Up omp

1. Install omp on the machine running the T3 Code server. T3 Code supports omp 18.20.0 or newer.
2. Run `omp` in a terminal, then `/login` to connect your model provider, or configure a provider in
   `~/.omp/agent`.
3. Open T3 Code Settings, enable omp, and refresh the provider.

If `omp` is not on the server's `PATH`, set omp's binary path to the executable. Provider
environment variables and launch arguments are also available, for example to point
`PI_CODING_AGENT_DIR` at another agent directory or to choose a profile with `--profile`. T3 Code
rejects launch arguments that change omp's execution mode, select a session, or set its approval
mode, because T3 owns those parts of the process lifecycle.

T3 Code does not update omp for you. Update it with `omp update`.

## What Carries Over

T3 Code discovers the models omp reports and the thinking levels each one supports. A thread that
selects the `omp default` model keeps whatever model omp's own configuration chooses. Threads use
omp's native session files for resume, rollback, and forks, and switching providers uses portable
conversation context. omp's skills appear in the composer's `$` menu, and omp's custom and
file-based commands appear as slash commands. `/compact` summarizes the conversation the way omp
does.

The thread details context window follows omp's own usage reporting, and the composer's context
ring and output speed read each turn's token counts. omp's tool calls appear in the work log like any
other agent's, including edits as file changes and commands with their output. Images attached to a
message are sent to models that accept them.

Extension dialogs (`select`, `confirm`, `input`, `editor`) appear in the T3 Code composer.

## Permission Modes

T3 Code starts omp with the approval mode that matches the thread's permission mode, so omp
itself enforces it:

- **Supervised** uses omp's `always-ask`: omp asks before commands, edits, and other tools that can
  change things. Read-only tools continue.
- **Auto-accept edits** uses `write`: omp allows edits and asks before commands and other tools.
- **Full access** uses `yolo`: omp does not ask.

The **Auto** option is not shown for omp, because omp has no automatic approval reviewer. Threads that
already stored Auto behave and display as Supervised. omp's own tool policies and restricted
folders still apply in every mode, and its approval prompts reach you in the conversation. Choosing
_Allow for session_ remembers an identical request for the rest of the session.

Changing the mode restarts the omp session and resumes the same native conversation.

## T3 Code's Tools

On threads where T3 Code offers its tools, omp receives them as tools named `mcp__t3-code__…`,
including `delegate_task`. A task you delegate creates a durable child thread in the shared
subagent UI. omp's own `task` tool runs in omp's process and appears as an ordinary tool call, not as
a subagent.

## Not Supported

- omp's `ask` tool is not available. omp only offers it in a mode that cannot receive T3 Code's
  tools, so T3 Code runs omp in the mode that can. Extension dialogs still work.
- omp does not write thread titles, commit messages, or other [text generation](./text-generation.md);
  pick another model for them.
- omp usage does not appear in the usage page.
- Status text that omp extensions publish is not shown near the composer.

## Troubleshooting

- If omp is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open omp directly and confirm its authentication and model configuration.
- If discovery cannot complete, T3 Code keeps omp available with the `omp default` model. Start a
  thread to let the live session retry.
- If a check times out, raise `T3CODE_OMP_PROBE_TIMEOUT_MS`.
