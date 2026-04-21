# How it works

## Bash interception

The extension registers its own `bash` tool with Pi via `createBashTool(...)`.

For sandboxed execution it uses a `spawnHook` that replaces the original shell command with a `bwrap` invocation. There are no temp files anymore — the command is passed through `bash -c` with shell escaping.

At a high level, sandboxed execution looks like this:

1. Pi prepares the bash command.
2. The extension's `spawnHook` wraps it in `bwrap`.
3. `bwrap` remounts `/` read-only, adds `/dev` and `/proc`, and optionally unshares the network namespace.
4. The wrapped command runs under `bash -c` inside that sandbox.

## The local bwrap command

A typical invocation looks like this:

```bash
bwrap \
  --die-with-parent \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --unshare-net \
  --chdir /project \
  bash -c 'ls -la'
```

### Mount breakdown

| Flag | What it does |
|------|-------------|
| `--die-with-parent` | Kill the sandbox if the parent Pi process dies. Prevents orphaned sandboxes. |
| `--ro-bind / /` | Mount the entire host filesystem read-only inside the sandbox. This is the core write barrier. |
| `--dev /dev` | Provide common device nodes such as `/dev/null`. |
| `--proc /proc` | Provide `/proc` so normal shell/process behavior still works. |
| `--unshare-net` | Isolate TCP/UDP networking unless `sandbox.network` is `true`. |
| `--chdir <cwd>` | Preserve Pi's working directory inside the sandbox. |
| `bash -c ...` | Execute the original command without creating temp script files. |

## Writable paths

By default, nothing is writable.

When you configure `sandbox.writable`, the extension adds extra mounts before the command runs:

- `/tmp` becomes `--tmpfs /tmp`, giving the sandbox an isolated ephemeral temp directory.
- Any other configured path becomes `--bind <path> <path>`, which is a real read-write bind mount to the host path.

Example:

```bash
bwrap \
  --die-with-parent \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --bind /workspace/cache /workspace/cache \
  --chdir /project \
  bash -c 'sort big-file.txt'
```

## SSH policy shim

When `sshPolicy.mode` is `"require-remote-bwrap"`, the sandbox also shadows `ssh` with a shim.

The wrapper does three things:

1. Bind-mount the real ssh client to a private internal path.
2. Bind-mount the shim over the normal `ssh` path inside the sandbox.
3. Pass policy settings to the shim via environment variables.

That lets normal shell commands still call `ssh`, but under a controlled entrypoint.

The shim then:

1. Parses ssh argv directly.
2. Re-execs ssh with a sterile config (`-F /dev/null` plus hardcoded safe options) so normal ssh config aliases and local hooks cannot change the execution path.
3. Rejects unsupported modes such as interactive `ssh host` or forwarding-heavy flows.
4. Probes the remote host for `bwrap`.
5. Re-execs the real ssh client only if the probe succeeds.
6. Wraps the remote command in `bwrap ... bash -lc ...` on the remote side.

This is how local sandboxed bash can require a remote read-only sandbox before allowing remote execution.

## User bash (`!` / `!!`)

Pi's interactive user bash commands are handled through the `user_bash` event.

When read-only mode is active, the extension returns sandboxed bash operations there too. That keeps `!` and `!!` aligned with normal bash tool calls.

## Fail-closed behavior

If read-only mode is enabled but local `bwrap` is unavailable, the extension does not silently fall back to unrestricted execution.

Instead, bash execution fails closed with an error so the agent cannot escape the intended policy by accident.
