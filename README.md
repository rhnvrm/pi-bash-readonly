# pi-bash-readonly

Sandboxed read-only bash for [Pi](https://github.com/badlogic/pi-mono) agents via [bwrap](https://github.com/containers/bubblewrap).

## Install

```bash
pi install npm:pi-bash-readonly
```

## What it does

Every `bash` tool call is wrapped in a bwrap sub-sandbox where the entire filesystem is mounted read-only (`--ro-bind / /`). By default, **nothing is writable** and **network is isolated** via `--unshare-net`.

This uses Linux mount and network namespaces. Unlike regex-based command filtering, writes are blocked at the filesystem level and TCP/UDP network access is blocked via namespace isolation — from any language runtime (Python, Perl, dd, etc.).

> **Note:** Network isolation blocks TCP/UDP but Unix domain sockets on the mounted filesystem may still be reachable. See [limitations](docs/01-guide/limitations.md) for details.

User bash commands (`!` and `!!` in the TUI) are also sandboxed when read-only mode is active.

When sandboxed bash invokes `ssh`, the extension only allows `ssh ... <destination> <remote-command...>` style execution and requires the remote host to have `bwrap`. The shim runs ssh with a sterile config (`-F /dev/null` plus hardcoded safe options), so interactive `ssh host` usage, host aliases, `ProxyCommand`, and `LocalCommand` from normal ssh config are ignored in read-only mode. To let sandboxed bash reach remote hosts at all, set `sandbox.network: true`.

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

Preferred structured format:

```json
{
  "enabled": true,
  "execution": { "type": "local" },
  "sandbox": {
    "writable": ["/tmp"],
    "network": false
  },
  "sshPolicy": {
    "mode": "require-remote-bwrap"
  }
}
```

Legacy flat format still works:

```json
{
  "enabled": true,
  "writable": ["/tmp"],
  "network": false
}
```

Top-level `writable` and `network` are deprecated. The extension logs a warning to stderr during config load so existing configs keep working while users migrate.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Initial sandbox state. Overridden by agent frontmatter. |
| `execution.type` | `"local"` | Execution mode for the bash tool. Use `"local"` for normal local bash, or `"ssh"` to run bash on a configured remote host over SSH. |
| `sandbox.writable` | `[]` | Paths to mount writable inside the sandbox. `/tmp` gets an isolated tmpfs (not the host /tmp). Other paths are bind-mounted read-write. |
| `sandbox.network` | `false` | Allow network access inside the sandbox. Default is `false` (network isolated via `--unshare-net`). Set to `true` if agents need to fetch packages, clone repos, or make HTTP requests. |
| `sshPolicy.mode` | `"require-remote-bwrap"` | Policy for `ssh` invoked from sandboxed bash. `require-remote-bwrap` only allows `ssh ... <destination> <remote-command...>` style usage, forces ssh to run with a sterile config (`-F /dev/null` plus safe hardcoded options), and requires the remote host to have `bwrap`. Set `sandbox.network: true` if you want sandboxed ssh to reach remote hosts at all. Set to `"off"` to disable the ssh shim. |

Without `"/tmp"` in `sandbox.writable`, commands like `sort` on large inputs will fail since they need temp space. Add it if your agents run commands that need scratch space.

Remote bash mode example:

```json
{
  "execution": {
    "type": "ssh",
    "host": "user@example.com",
    "cwd": "/srv/project",
    "args": ["-p", "2222"]
  },
  "sandbox": {
    "writable": ["/tmp"],
    "network": false
  }
}
```

In that mode, the `bash` tool runs on the configured remote host. File tools such as `read`, `grep`, `find`, `ls`, `edit`, and `write` remain local. This is intentionally a split-brain setup, not a full remote workspace abstraction.

`execution.host` must be a literal SSH destination such as `user@example.com`. It must not be empty, contain whitespace, or start with `-`.

If you need remote shell syntax in local execution mode, be explicit: prefer `ssh host bash -lc '...'` over relying on interactive ssh or forwarding-heavy flows. Pass connection details explicitly with supported flags such as `-i`, `-p`, `-l`, or safe `-o` options, because the shim intentionally ignores normal ssh config files and aliases.

### Resolution order

1. Agent frontmatter `bash-readonly` field (if `PI_AGENT` is set and agent file found)
2. Config file `enabled` field
3. Default: `true` (sandboxed)

Agent frontmatter only controls the initial readonly state and lock. Writable paths and network settings stay in JSON config.

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

1. Registers a custom `bash` tool using `createBashTool`
2. In local mode, uses a `spawnHook` to wrap commands in bwrap via `bash -c` with shell escaping
3. In configured remote mode, swaps in SSH-backed bash operations and optionally wraps remote commands in remote `bwrap`
4. Intercepts `user_bash` events so `!` and `!!` follow the same local-vs-remote execution path
5. Reads agent frontmatter plus structured/legacy JSON config for per-agent configuration

## Requirements

- Linux with [bwrap](https://github.com/containers/bubblewrap) in `PATH`
  - Debian/Ubuntu: `sudo apt install bubblewrap`
  - Fedora: `sudo dnf install bubblewrap`
  - Arch: `sudo pacman -S bubblewrap`
- `ssh` in `PATH` if you use either controlled local SSH or configured remote bash mode
- If read-only mode is enabled and `bwrap` is not available, bash fails closed with an error instead of silently falling back to unrestricted execution

## License

MIT
