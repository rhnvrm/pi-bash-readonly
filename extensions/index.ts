/**
 * pi-bash-readonly — Sandboxed read-only bash via bwrap.
 *
 * Intercepts bash tool calls and wraps commands in a bwrap sub-sandbox
 * where the entire filesystem is mounted read-only (`--ro-bind / /`).
 *
 * By default, nothing is writable — truly read-only. Configure writable
 * paths (e.g. /tmp for sort/awk) via .pi/pi-bash-readonly.json:
 *
 *   { "writable": ["/tmp"] }
 *
 * This is a hard security boundary using Linux mount namespaces.
 * Unlike regex-based command filtering, this catches writes from any
 * language runtime (python, perl, dd, etc.).
 *
 * Behavior depends on the agent's tool set:
 * - Agents WITHOUT edit/write tools:
 *   Always-on bwrap, no toggle. These agents are read-only by design.
 * - Agents WITH edit/write tools:
 *   `/readonly` command toggles bwrap wrapping on/off. Defaults to off.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadConfig } from "../config.js";

/** Shell-escape a string by wrapping in single quotes. */
function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const config = loadConfig(cwd);

	// Check if bwrap is available at load time
	let hasBwrap = true;
	try {
		execSync("which bwrap", { stdio: "ignore" });
	} catch {
		hasBwrap = false;
		console.warn("[pi-bash-readonly] bwrap not found — falling back to unrestricted bash");
	}

	// Resolve writable paths, skip non-existent ones
	const writablePaths = config.writable.filter((p) => {
		if (!existsSync(p)) {
			console.warn(`[pi-bash-readonly] writable path does not exist, skipping: ${p}`);
			return false;
		}
		return true;
	});

	// Determines whether bwrap wrapping is active.
	// For read-only agents (no edit/write): always true, no toggle.
	// For write-capable agents: toggled via /readonly command, starts off.
	let readOnly = true;
	let isWriteCapableAgent = false;

	pi.on("session_start", async () => {
		const activeTools = pi.getActiveTools();
		isWriteCapableAgent = activeTools.includes("edit") || activeTools.includes("write");

		if (isWriteCapableAgent) {
			// Write-capable agents start with readonly off — they opted into
			// having edit/write and shouldn't be surprised by bwrap failures.
			readOnly = false;
		}
	});

	// Only register /readonly for agents that have edit/write tools.
	// Read-only agents (scout, review, etc.) get permanent bwrap with no escape.
	pi.registerCommand("readonly", {
		description: "Toggle read-only bash (bwrap sandbox)",
		handler: async (_args, ctx) => {
			if (!isWriteCapableAgent) {
				ctx.ui.notify("This agent is read-only by design — toggle not available", "warning");
				return;
			}
			if (!hasBwrap) {
				ctx.ui.notify("bwrap not found — read-only mode unavailable", "error");
				return;
			}
			readOnly = !readOnly;
			ctx.ui.notify(readOnly ? "🔒 bash: read-only (bwrap)" : "🔓 bash: full access", "info");
			ctx.ui.setStatus("bash-ro", readOnly ? "🔒 ro" : "");
		},
	});

	pi.on("tool_call", async (event) => {
		if (!hasBwrap || !readOnly) return;
		if (!isToolCallEventType("bash", event)) return;

		const originalCommand = event.input.command;

		// Write the original command to a temp file to avoid nested shell
		// quoting issues across 4 layers (pi → bash -c → bwrap → bash).
		const tmpFile = `/tmp/pi-bash-ro-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`;
		writeFileSync(tmpFile, originalCommand, { mode: 0o700 });

		// Build the bwrap command:
		//   --die-with-parent     exit if parent pi process dies
		//   --ro-bind / /         entire filesystem read-only (namespace-enforced)
		//   --dev /dev            device nodes (needed for /dev/null, /dev/urandom, etc.)
		//   --proc /proc          proc filesystem (needed for process info)
		//   --ro-bind <tmpFile>   mount the command script read-only
		//   --tmpfs/--bind        writable paths from config
		//   --chdir <cwd>         preserve working directory
		const parts = [
			"bwrap",
			"--die-with-parent",
			"--ro-bind / /",
			"--dev /dev",
			"--proc /proc",
		];

		// Add configured writable paths before the script mount,
		// so --tmpfs /tmp doesn't shadow the --ro-bind of our script file.
		for (const p of writablePaths) {
			if (p === "/tmp") {
				// /tmp gets an isolated tmpfs — not the host /tmp
				parts.push("--tmpfs /tmp");
			} else {
				parts.push(`--bind ${shellEscape(p)} ${shellEscape(p)}`);
			}
		}

		// Mount the script file read-only. This must come AFTER --tmpfs /tmp
		// so it overlays onto the tmpfs rather than being hidden by it.
		parts.push(`--ro-bind ${tmpFile} ${tmpFile}`);

		parts.push(`--chdir ${shellEscape(cwd)}`);
		parts.push(`bash ${tmpFile}`);

		const bwrapCmd = parts.join(" ");

		// Run bwrap, capture exit code, clean up temp file regardless of outcome.
		// The cleanup runs in the OUTER shell (after bwrap exits) where /tmp is writable.
		event.input.command = `${bwrapCmd}; __exit=$?; rm -f ${tmpFile}; exit $__exit`;
	});
}
