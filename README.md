# pi-bash-readonly

Sandboxed read-only bash for [Pi](https://github.com/badlogic/pi-mono) agents via [bwrap](https://github.com/containers/bubblewrap).

## Install

```bash
pi install npm:pi-bash-readonly
```

## What it does

Every `bash` tool call is wrapped in a bwrap sub-sandbox where the entire filesystem is mounted read-only (`--ro-bind / /`). By default, **nothing is writable** — truly read-only.

This uses Linux mount namespaces. Unlike regex-based command filtering, writes are blocked at the filesystem level — from any language runtime (Python, Perl, dd, etc.).

User bash commands (`!` and `!!` in the TUI) are also sandboxed when read-only mode is active.

## Configuration

### Agent frontmatter (recommended)

Set sandbox behavior per-agent in the agent's `.md` file:

```yaml
---
name: scout
bash-readonly: true
bash-readonly-locked: true
---
```

| Key | Default | Description |
|-----|---------|-------------|
| `bash-readonly` | — | Initial sandbox state. `true` = sandboxed, `false` = unrestricted. |
| `bash-readonly-locked` | `false` | When `true`, disables the `/readonly` toggle command. |

The extension reads the agent file using the `PI_AGENT` environment variable. It searches `.pi/agents/` and any paths configured in `.pi/agents.json` `agentPaths`.

### Config file

Configure via `.pi/pi-bash-readonly.json` (project) or `~/.pi/agent/pi-bash-readonly.json` (user). Project config takes priority.

```json
{
  "writable": ["/tmp"],
  "enabled": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `writable` | `[]` | Paths to mount writable inside the sandbox. `/tmp` gets an isolated tmpfs (not the host /tmp). Other paths are bind-mounted read-write. |
| `enabled` | `true` | Initial sandbox state. Overridden by agent frontmatter. |

Without `"/tmp"` in `writable`, commands like `sort` on large inputs will fail since they need temp space. Add it if your agents run commands that need scratch space.

### Resolution order

1. Agent frontmatter `bash-readonly` field (if `PI_AGENT` is set and agent file found)
2. Config file `enabled` field
3. Default: `true` (sandboxed)

## Usage

Add to an agent's extensions:

```yaml
extensions:
  - pi-bash-readonly
```

Use the `/readonly` command in an interactive session to toggle:

```
/readonly     # 🔒 bash: read-only (bwrap)
/readonly     # 🔓 bash: full access
```

If `bash-readonly-locked: true` is set in the agent's frontmatter, the toggle shows a "locked" notification and does nothing.

## Visual indicator

When the sandbox is active, bash tool calls display a 🔒 icon in the tool header:

```
🔒 bash ls -la
```

The status bar also shows `🔒 ro` when sandboxed.

## How it works

1. Registers a custom `bash` tool using `createBashTool` with a `spawnHook`
2. The `spawnHook` wraps commands in bwrap via `bash -c` with shell escaping (no temp files)
3. Intercepts `user_bash` events to sandbox `!` and `!!` commands too
4. Reads agent frontmatter via `PI_AGENT` env var for per-agent configuration

## Requirements

- Linux with [bwrap](https://github.com/containers/bubblewrap) in `PATH`
  - Debian/Ubuntu: `sudo apt install bubblewrap`
  - Fedora: `sudo dnf install bubblewrap`
  - Arch: `sudo pacman -S bubblewrap`
- Falls back gracefully to unrestricted bash with a warning if bwrap is not found

## License

MIT
