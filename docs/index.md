# pi-bash-readonly

Sandboxed read-only bash for [Pi](https://github.com/badlogic/pi-mono) agents via [bwrap](https://github.com/containers/bubblewrap).

When this extension is active, every `bash` tool call runs inside a bwrap sandbox where the entire filesystem is mounted read-only. By default **nothing is writable** — truly read-only.

This uses Linux mount namespaces. Unlike regex-based command filtering, writes are blocked at the filesystem level — from any language runtime (Python, Perl, dd, etc.).

## Why

Pi agents can run arbitrary bash commands. For agents that should only read code (reviewers, scouts, auditors), you want a guarantee that bash can't modify anything — not just a prompt instruction that can be ignored.

`pi-bash-readonly` provides that guarantee at the OS level. A read-only bind mount cannot be bypassed from userspace, regardless of what the LLM tries.

## Supported setups

- **Local read-only bash** — run bash locally inside `bwrap`
- **Local bash with controlled SSH** — keep bash local, but restrict sandboxed `ssh` to a narrow safe subset with remote-`bwrap` enforcement
- **Configured remote bash** — run the `bash` tool itself on a configured remote host over SSH while file tools remain local

Safe defaults are conservative on purpose: sandbox on, local execution, no writable paths, network off, and remote-`bwrap` required for sandboxed SSH.

## Documentation

- [Quickstart](quickstart.md)
- [How it works](01-guide/how-it-works.md)
- [Configuration](01-guide/configuration.md)
- [Agent modes](01-guide/agent-modes.md)
- [Limitations](01-guide/limitations.md)

## Validation

For SSH behavior, run the Docker-based harness from the repo root:

```bash
bun run test:ssh-docker
```

It brings up `with-bwrap` and `without-bwrap` sshd targets and exercises both the local SSH shim path and configured remote bash mode.
