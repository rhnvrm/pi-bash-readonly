# Agent modes

The extension does not infer agent mode from the tool list. It follows agent frontmatter plus JSON config.

## Frontmatter-controlled startup mode

Use agent frontmatter to choose the initial state for a specific agent:

```yaml
---
name: scout
bash-readonly: true
bash-readonly-locked: true
---
```

- `bash-readonly: true` starts the session with sandboxed bash enabled.
- `bash-readonly: false` starts the session with unrestricted bash.
- `bash-readonly-locked: true` disables the `/readonly` toggle.

If frontmatter does not specify `bash-readonly`, the extension falls back to JSON config and then to the default of `enabled: true`.

## Locked read-only agents

This is the usual setup for review/scout-style agents:

```yaml
---
name: scout
bash-readonly: true
bash-readonly-locked: true
extensions:
  - pi-bash-readonly
---
```

Behavior:

- bash starts in read-only mode
- `/readonly` cannot disable it
- the status bar shows `🔒 ro`

## Toggleable agents

For a write-capable agent that sometimes needs a safer bash mode, leave the lock off:

```yaml
---
name: bosun
bash-readonly: false
bash-readonly-locked: false
extensions:
  - pi-bash-readonly
---
```

Behavior:

- bash starts unrestricted
- `/readonly` toggles between unrestricted and sandboxed bash
- the tool header shows `🔒` when sandboxing is active

## Frontmatter vs JSON

Frontmatter only controls:

- the initial read-only state
- whether toggling is locked

JSON config still controls execution details such as:

- local vs configured remote bash execution
- writable paths
- network access
- ssh policy

That split keeps agent identity decisions in frontmatter and execution policy details in config.
