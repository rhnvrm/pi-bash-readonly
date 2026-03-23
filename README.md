# pi-bash-readonly

Sandboxed read-only bash for [Pi](https://github.com/badlogic/pi-mono) agents via [bwrap](https://github.com/containers/bubblewrap).

## Install

```bash
pi install npm:pi-bash-readonly
```

## What it does

Every `bash` tool call is wrapped in a bwrap sub-sandbox where the entire filesystem is mounted read-only (`--ro-bind / /`). By default, **nothing is writable** — truly read-only.

This uses Linux mount namespaces. Unlike regex-based command filtering, writes are blocked at the filesystem level — from any language runtime (Python, Perl, dd, etc.).

## Configuration

Configure via `.pi/pi-bash-readonly.json` (project) or `~/.pi/agent/pi-bash-readonly.json` (user). Project config takes priority.

```json
{
  "writable": ["/tmp"]
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `writable` | `[]` | Paths to mount writable inside the sandbox. `/tmp` gets an isolated tmpfs (not the host /tmp). Other paths are bind-mounted read-write. |

Without `"/tmp"` in `writable`, commands like `sort` on large inputs will fail since they need temp storage. Add it if your agents run commands that need scratch space.

## Behavior

The extension adapts based on which tools the agent has:

| Agent type | Behavior |
|-----------|----------|
| **Without edit/write** (e.g. scout, review) | bwrap is always on, no toggle. Read-only by design. |
| **With edit/write** (e.g. coding agents) | `/readonly` command toggles bwrap on/off. Defaults to off. |

## Usage

Add to an agent's extensions:

```yaml
extensions:
  - pi-bash-readonly
```

Or use the `/readonly` command in an interactive session to toggle:

```
/readonly     # 🔒 bash: read-only (bwrap)
/readonly     # 🔓 bash: full access
```

## How it works

1. Intercepts `tool_call` events for the bash tool
2. Writes the original command to a temp file (avoids nested shell quoting issues)
3. Replaces the command with a `bwrap` invocation that runs the temp file in a read-only sub-sandbox
4. Cleans up the temp file after execution

## Requirements

- Linux with [bwrap](https://github.com/containers/bubblewrap) in `PATH`
  - Debian/Ubuntu: `sudo apt install bubblewrap`
  - Fedora: `sudo dnf install bubblewrap`
  - Arch: `sudo pacman -S bubblewrap`
- Falls back gracefully to unrestricted bash with a warning if bwrap is not found

## License

MIT
