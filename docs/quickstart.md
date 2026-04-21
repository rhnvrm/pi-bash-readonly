# Quickstart

## Install

```bash
pi install npm:pi-bash-readonly
```

## Prerequisites

bwrap must be installed on your system:

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap

# Arch
sudo pacman -S bubblewrap
```

If read-only mode is enabled and `bwrap` is not found, the extension logs a warning and fails closed instead of silently falling back to unrestricted bash.

## Add to an agent

In your agent definition (`.pi/agents/my-agent.md`):

```yaml
---
extensions:
  - pi-bash-readonly
tools:
  - read
  - grep
  - find
  - ls
  - bash
---
```

This agent can now run bash commands but cannot write to the filesystem.

## Try it

Start a session with the agent and run:

```
> list all files in src/

# Agent runs: find src/ -type f
# Works fine — reading is allowed

> write "hello" to /tmp/test.txt

# Agent runs: echo "hello" > /tmp/test.txt
# Fails with: Read-only file system
```

## Allow scratch space

If your agents need temp storage (for `sort`, `awk`, etc.), add `/tmp` as a writable path:

```json
// .pi/pi-bash-readonly.json
{
  "execution": { "type": "local" },
  "sandbox": {
    "writable": ["/tmp"]
  }
}
```

The `/tmp` inside the sandbox is an isolated tmpfs — not the host `/tmp`. It's destroyed when each command exits.

## Allow controlled ssh

If you want sandboxed bash to reach remote hosts, enable network and keep the default ssh policy:

```json
// .pi/pi-bash-readonly.json
{
  "sandbox": {
    "network": true
  },
  "sshPolicy": {
    "mode": "require-remote-bwrap"
  }
}
```

With that policy, sandboxed `ssh` only allows `ssh ... <destination> <remote-command...>` style usage and refuses interactive sessions such as `ssh host`.

## Use configured remote bash

If you want the `bash` tool itself to run on a known remote host:

```json
// .pi/pi-bash-readonly.json
{
  "execution": {
    "type": "ssh",
    "host": "user@example.com",
    "cwd": "/srv/project"
  }
}
```

In this mode, `bash` runs remotely over SSH, but file tools still operate locally. Readonly mode still applies: when it is on, the extension probes the remote host for `bwrap` and refuses execution if the remote host does not provide it.

## Validate the SSH flows locally

This repo includes a Docker-based SSH validation harness:

```bash
bun run test:ssh-docker
```

It starts two disposable sshd targets and exercises:

- local sandboxed `ssh` against a host with `bwrap`
- local sandboxed `ssh` against a host without `bwrap`
- configured remote bash in readonly mode against both targets

The `with-bwrap` target uses a small test stub for `bwrap`, so this harness validates SSH policy and execution-path behavior rather than full nested remote namespace isolation.
