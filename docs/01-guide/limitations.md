# Limitations

## Linux only

bwrap uses Linux-specific kernel features (namespaces, bind mounts). It does not work on macOS or Windows.

On non-Linux systems, the extension falls back to unrestricted bash with a warning.

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

## No network isolation

bwrap as configured here does not restrict network access. Commands inside the sandbox can still make network requests (curl, wget, etc.).

Network sandboxing would require `--unshare-net`, which breaks many legitimate commands. This is intentionally not done.

## Config is loaded once

Configuration and writable paths are resolved when the extension loads. Changing `.pi/pi-bash-readonly.json` mid-session requires restarting Pi.

## Nested bwrap

If Pi itself is already running inside a bwrap sandbox (or similar container), nested bwrap may not work depending on the outer sandbox's permissions. bwrap needs the ability to create new mount namespaces.
