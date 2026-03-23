# Agent modes

The extension behaves differently depending on what tools the agent has.

## Read-only agents

Agents **without** `edit` or `write` tools (e.g. scout, review, oracle):

- bwrap is **always on** — every bash call is sandboxed
- No `/readonly` toggle — these agents are read-only by design
- If the user runs `/readonly`, they see: "This agent is read-only by design — toggle not available"

This is the primary use case. You define a read-only agent and `pi-bash-readonly` ensures bash can't write anything.

## Write-capable agents

Agents **with** `edit` or `write` tools (e.g. bosun, lite, deckhand):

- bwrap is **off by default** — bash runs normally
- `/readonly` command toggles bwrap on/off
- Status bar shows `🔒 ro` when active

This lets you temporarily lock down bash for a write-capable agent. For example, during a review phase where the agent should only read.

## Detection

Agent type is detected at session start via `pi.getActiveTools()`. If the tool list includes `edit` or `write`, the agent is considered write-capable.

This means the behavior is set once at session start and doesn't change if tools are dynamically added or removed mid-session.
