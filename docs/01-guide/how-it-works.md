# How it works

## Interception

The extension hooks into Pi's `tool_call` event. When a bash tool call fires:

1. The original command is written to a temp file (`/tmp/pi-bash-ro-<pid>-<ts>-<rand>.sh`) with mode `0o700` (owner-only)
2. The command is replaced with a bwrap invocation that runs the temp file
3. After bwrap exits, the temp file is cleaned up in the outer shell

Writing to a temp file avoids nested shell quoting issues. The command passes through 4 layers (Pi → bash -c → bwrap → bash), and escaping across all of them is error-prone.

## The bwrap command

A typical invocation looks like:

```bash
bwrap \
  --die-with-parent \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --ro-bind /tmp/script.sh /tmp/script.sh \
  --chdir /project \
  bash /tmp/script.sh
```

### Mount breakdown

| Flag | What it does |
|------|-------------|
| `--die-with-parent` | Kill the sandbox if the parent Pi process dies. Prevents orphans. |
| `--ro-bind / /` | Mount the entire root filesystem read-only. This is the core enforcement. |
| `--dev /dev` | Provide device nodes (`/dev/null`, `/dev/urandom`, etc.) |
| `--proc /proc` | Provide `/proc` filesystem (process info, `$$`, etc.) |
| `--ro-bind <script> <script>` | Mount the command script read-only inside the sandbox |
| `--chdir <cwd>` | Set working directory to match Pi's cwd |

### With writable paths configured

When `writable` paths are set in config, additional mounts are added **before** the script mount:

```bash
bwrap \
  --die-with-parent \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \                              # writable: ["/tmp"]
  --bind /workspace /workspace \              # writable: ["/workspace"]
  --ro-bind /tmp/script.sh /tmp/script.sh \   # after tmpfs so it overlays
  --chdir /project \
  bash /tmp/script.sh
```

Mount ordering matters: `--tmpfs /tmp` must come before `--ro-bind /tmp/script.sh` so the script file overlays onto the tmpfs rather than being hidden by it.

## Exit code preservation

The replacement command captures bwrap's exit code and re-exits with it:

```bash
bwrap ...; __exit=$?; rm -f /tmp/script.sh; exit $__exit
```

The `rm -f` runs in the outer shell (where `/tmp` is the real host `/tmp`), so cleanup always works.

## What gets blocked

Any write syscall to a read-only mount returns `EROFS` (Read-only file system). This includes:

- `echo > file`, `tee`, `dd`
- `touch`, `mkdir`, `rm`, `mv`, `cp` (to read-only targets)
- `python -c "open('f','w')"`
- `perl -e "open(F,'>f')"`
- Any binary that calls `open(O_WRONLY)`, `write()`, `unlink()`, etc.
