# Limitations

## Linux only

bwrap uses Linux-specific kernel features (namespaces, bind mounts). It does not work on macOS or Windows.

On non-Linux systems, read-only mode is unavailable because `bwrap` cannot run there. If read-only mode is enabled anyway, bash fails closed with an error instead of silently falling back to unrestricted execution.

## Only protects bash

The extension only intercepts the `bash` tool. Pi's `edit` and `write` tools are separate and not affected — they go through Pi's own file operations, not through bwrap.

If your agent has `edit` or `write` tools, those can still modify files. To make an agent truly read-only, don't give it those tools:

```yaml
tools:
  - read
  - grep
  - find
  - ls
  - bash  # sandboxed by pi-bash-readonly
  # no edit, no write
```

## Writable paths are real

If you configure writable paths other than `/tmp`, those are actual read-write bind mounts of the host filesystem. Changes made inside the sandbox to those paths persist after the command exits.

`/tmp` is the exception — it gets an isolated tmpfs that's destroyed when the command exits.

## Network isolation caveats

By default, the sandbox uses `--unshare-net` to isolate network access. TCP/UDP connections (curl, wget, etc.) are blocked inside the sandbox.

To allow network access, set `"sandbox": { "network": true }` in `.pi/pi-bash-readonly.json` (or use the legacy top-level `"network": true` during migration).

However, `--unshare-net` only creates a new network namespace — it does **not** block all host communication:

- **Unix domain sockets** on the mounted filesystem are still reachable if permissions allow (e.g. `docker.sock`-like surfaces).
- **Other IPC channels** (shared memory, signals) are not affected by network namespace isolation.

For most use cases (blocking HTTP requests, preventing data exfiltration over the network), `--unshare-net` is sufficient.

## SSH policy is intentionally narrow

When `sshPolicy.mode` is `"require-remote-bwrap"`, the sandbox shadows `ssh` with a shim that only allows non-interactive `ssh ... <destination> <remote-command...>` style execution.

That means these are rejected or ignored in read-only mode:

- interactive `ssh host`
- custom ssh config files such as `-F ~/.ssh/config`
- host aliases, `ProxyCommand`, and `LocalCommand` from normal ssh config
- forwarding and tunnel options such as `-L`, `-R`, `-D`, `-W`
- jump-host / control-socket style flows outside the small supported subset

If you need remote shell syntax, prefer an explicit remote shell command such as `ssh host bash -lc '...'` rather than relying on interactive behavior. Pass connection details explicitly with supported flags.

## Fail-closed dependency checks

If read-only mode is enabled with `sandbox.network: true` and `sshPolicy.mode: "require-remote-bwrap"`, but the local ssh shim cannot be prepared, the extension blocks readonly bash execution rather than trying to inspect shell text for `ssh` usage.

That is intentionally conservative: it may block non-ssh commands in a misconfigured session, but it avoids a silent policy bypass.

## Remote bash is split-brain by design

When `execution.type` is `"ssh"`, only the `bash` tool moves to the remote host.

That means:

- `bash` runs remotely
- `read`, `grep`, `find`, `ls`, `edit`, and `write` still operate on local files
- local and remote working directories may correspond to mirrored repos, but the extension does not enforce that for you

Do not treat this as a full remote workspace abstraction.

## Config is loaded once

Configuration and writable paths are resolved when the extension loads. Changing `.pi/pi-bash-readonly.json` mid-session requires restarting Pi.

## Nested bwrap

If Pi itself is already running inside a bwrap sandbox (or similar container), nested bwrap may not work depending on the outer sandbox's permissions. bwrap needs the ability to create new mount namespaces.
