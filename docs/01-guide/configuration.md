# Configuration

Configuration comes from two places:

1. **Agent frontmatter** — `bash-readonly`, `bash-readonly-locked`
2. **JSON config files**
   - project: `.pi/pi-bash-readonly.json` (highest JSON priority)
   - user: `~/.pi/agent/pi-bash-readonly.json`
3. **Defaults**

## What frontmatter controls

Agent frontmatter only controls the initial readonly state and whether `/readonly` is locked:

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

Frontmatter does **not** configure writable paths or network settings. Those stay in JSON config.

## Preferred JSON format

The preferred JSON format is structured:

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

### Keys

#### `enabled`

**Type**: `boolean`
**Default**: `true`

Initial sandbox state. Agent frontmatter `bash-readonly` overrides this when present.

#### `execution`

**Type**: object
**Default**: `{ "type": "local" }`

Execution mode for the `bash` tool.

Local mode:

```json
{
  "execution": { "type": "local" }
}
```

Configured remote mode:

```json
{
  "execution": {
    "type": "ssh",
    "host": "user@example.com",
    "cwd": "/srv/project",
    "args": ["-p", "2222"]
  }
}
```

In `"ssh"` mode, the `bash` tool runs on the configured remote host. File tools remain local. This is intentionally a split-brain setup, not a full remote workspace abstraction.

`execution.host` must be a literal SSH destination such as `user@example.com` or `build-host`. It must not be empty, contain whitespace, or start with `-`.

#### `sshPolicy.mode`

**Type**: `"off" | "require-remote-bwrap"`
**Default**: `"require-remote-bwrap"`

Controls how sandboxed local bash handles `ssh`.

```json
{
  "sshPolicy": {
    "mode": "require-remote-bwrap"
  }
}
```

- `require-remote-bwrap`: shadow `ssh` inside the sandbox with a shim that only allows `ssh ... <destination> <remote-command...>` style usage, forces ssh to run with a sterile config (`-F /dev/null` plus safe hardcoded options), probes the remote host for `bwrap`, and only then re-execs the real ssh client with a remote `bwrap ... bash -lc ...` wrapper.
- `off`: disable the ssh shim entirely.

This policy matters only for local sandboxed bash. It does not change agent frontmatter.

Because the shim uses a sterile ssh config, normal `~/.ssh/config` host aliases and features such as `ProxyCommand` / `LocalCommand` are intentionally ignored in this mode. Pass connection details explicitly with supported flags instead.

#### `sandbox.writable`

**Type**: `string[]`  
**Default**: `[]`

Paths to mount writable inside the sandbox. By default nothing is writable.

```json
{
  "sandbox": {
    "writable": ["/tmp"]
  }
}
```

#### `sandbox.network`

**Type**: `boolean`
**Default**: `false`

Allow network access inside the sandbox. By default network is isolated with `--unshare-net`.

If you want sandboxed bash to reach remote hosts over `ssh`, this must be `true`. `sshPolicy.mode` controls how `ssh` behaves once network access is available.

```json
{
  "sandbox": {
    "network": true
  }
}
```

## Why the defaults are strict

The defaults are intentionally conservative:

- `enabled: true` — safer to start sandboxed and loosen intentionally than to assume unrestricted bash is acceptable.
- `execution.type: "local"` — avoids surprising split-brain remote behavior unless you opt in.
- `sandbox.writable: []` — nothing is writable unless you explicitly grant it.
- `sandbox.network: false` — network access is off unless you decide the agent needs it.
- `sshPolicy.mode: "require-remote-bwrap"` — if sandboxed local bash uses `ssh`, the remote side must confirm a read-only wrapper first.

That combination makes the extension fail closed by default instead of quietly expanding privileges.

## Legacy JSON format

The old flat format is still supported:

```json
{
  "enabled": true,
  "writable": ["/tmp"],
  "network": false
}
```

But top-level `writable` and `network` are deprecated. The extension prints a warning to stderr during config load so users can migrate over time.

### Migration

Legacy:

```json
{
  "enabled": true,
  "writable": ["/tmp"],
  "network": false
}
```

Preferred:

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

If both styles are present in the same file, structured keys win and the extension logs a warning.

## Layering and precedence

JSON config is merged in this order:

1. user config
2. project config
3. defaults

Each layer is normalized before merge. That means a project config can override only one field without resetting unrelated fields from user config.

Example:

**User config**

```json
{
  "sandbox": {
    "writable": ["/tmp"],
    "network": true
  }
}
```

**Project config**

```json
{
  "enabled": false,
  "sandbox": {
    "writable": ["/var/data"]
  }
}
```

Result:

```json
{
  "enabled": false,
  "execution": { "type": "local" },
  "sandbox": {
    "writable": ["/var/data"],
    "network": true
  },
  "sshPolicy": {
    "mode": "require-remote-bwrap"
  }
}
```

## Remote execution notes

When `execution.type` is `"ssh"`:

- `execution.host` is the SSH destination. It must be a literal destination value, not an option-like string.
- `execution.cwd` is the remote root directory for bash commands. If omitted, the extension resolves it with remote `pwd` on first use.
- `execution.args` is a small safe subset of SSH option flags such as `-i`, `-p`, `-l`, and selected safe `-o` options.
- Readonly mode still matters: when readonly is on, remote bash requires remote `bwrap`; when readonly is off, commands run remotely without the `bwrap` wrapper.
- File tools remain local even though bash runs remotely.

## How writable paths are mounted

| Path | Mount type | Notes |
|------|-----------|-------|
| `/tmp` | `--tmpfs /tmp` | Isolated ephemeral tmpfs. Not the host `/tmp`. Destroyed when the command exits. |
| Anything else | `--bind <path> <path>` | Read-write bind mount of the actual host path. Changes persist. |

## When to add `/tmp`

Many common commands need temp storage:

- `sort` on large inputs writes temp files
- `awk` may need scratch space
- `mktemp` creates files in `/tmp`
- process substitution (`<()`, `>()`) uses `/tmp`

If your agents only run simple commands (`ls`, `cat`, `grep`, `find`), you probably do not need it. If they run `sort`, `awk`, or anything that processes large data, add `"/tmp"` to writable.

## Validation

- Non-existent writable paths are skipped with a warning logged to stderr.
- Non-string entries in writable arrays are filtered out.
- If `sandbox.writable` or legacy `writable` is not an array, it defaults to `[]`.
- If `sandbox.network` or legacy `network` is not a boolean, it defaults to `false`.
- If `sshPolicy.mode` is omitted or invalid, it defaults to `"require-remote-bwrap"`.
- With `sshPolicy.mode: "require-remote-bwrap"`, sandboxed `ssh` is intentionally conservative: interactive `ssh host`, custom ssh config files, forwarding/tunnel options, and other unsupported modes are rejected.
