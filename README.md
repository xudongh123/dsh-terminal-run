# @local/dsh-terminal-run

DSH bundle: adds a **▶ 终端 / ▶ Term** button to shell code blocks in the conversation and runs the snippet in the right sidebar terminal (opening one when the Session has none).

- Host half (`index.js`): empty `apply()` — no RPC, no shell access.
- Client half (`client.js`): DOM-injected button + `ctx.webTerminals` / `ctx.sidebarRight` usage.

## Why client-only

The right sidebar terminal tab already owns a live attachment to its PTY (`dsh-api-terminal-controller`). A second attachment would take input control away from the tab's own view and never hand it back, so this plugin never attaches: it opens/focuses the tab, waits for that tab's view to become `writable`, then writes `command + "\r"` through it.

## Install

```
plugin_manager install_bundle { "target": "/abs/path/to/dsh-terminal-run" }
```

Local directories install as a link, so edits here take effect after a client reload (⌘R) or app restart.

## Behaviour

| Situation | Result |
| --- | --- |
| No terminal tab for this Session | opens `terminal` tab, writes the command |
| Tracked terminal tab still alive | focuses it and writes the command |
| Tracked terminal exited | closes the tab, opens a fresh one, retries once |
| Terminal never becomes writable | button flashes `✗ 失败`, nothing is executed |

Shell languages: bash, sh, shell, zsh, shellscript, console, powershell, pwsh, ps1, cmd, bat, batch, dos.
