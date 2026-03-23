# Configuration

Configuration is loaded from JSON files with layered priority:

1. **Project**: `.pi/pi-bash-readonly.json` (highest priority)
2. **User**: `~/.pi/agent/pi-bash-readonly.json`
3. **Defaults**

Project config overrides user config. Only one key is supported:

## `writable`

**Type**: `string[]`  
**Default**: `[]`

Paths to mount writable inside the sandbox. By default nothing is writable.

```json
{
  "writable": ["/tmp"]
}
```

### How paths are mounted

| Path | Mount type | Notes |
|------|-----------|-------|
| `/tmp` | `--tmpfs /tmp` | Isolated ephemeral tmpfs. Not the host `/tmp`. Destroyed when the command exits. |
| Anything else | `--bind <path> <path>` | Read-write bind mount of the actual host path. Changes persist. |

### When to add `/tmp`

Many common commands need temp storage:

- `sort` on large inputs writes temp files
- `awk` may need scratch space
- `mktemp` creates files in `/tmp`
- Process substitution (`<()`, `>()`) uses `/tmp`

If your agents only run simple commands (`ls`, `cat`, `grep`, `find`), you don't need it. If they run `sort`, `awk`, or anything that processes large data, add `"/tmp"` to writable.

### Validation

Non-existent paths are silently skipped with a warning logged to stderr. Non-string entries in the array are filtered out. If `writable` is not an array, it defaults to `[]`.
