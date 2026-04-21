/**
 * pi-bash-readonly — Sandboxed read-only bash via bwrap.
 *
 * Uses `createBashTool` with `spawnHook` to wrap bash commands in a bwrap
 * sub-sandbox where the entire filesystem is mounted read-only (`--ro-bind / /`).
 *
 * Configuration priority:
 * 1. Agent frontmatter: `bash-readonly: true/false`, `bash-readonly-locked: true/false`
 * 2. Config file `enabled` field
 * 3. Default: sandbox ON (true)
 *
 * Features:
 * - No temp files — commands are passed via `bash -c` with shell escaping
 * - `user_bash` sandboxing — `!` and `!!` commands also go through bwrap
 * - Visual indicator — 🔒 icon in bash tool header when sandboxed
 * - Agent frontmatter-driven config via PI_AGENT env var + gray-matter
 */

import type { BashOperations, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type { BashReadonlySshPolicyMode } from "../config.js";
import { loadConfig } from "../config.js";

const MISSING_BWRAP_MESSAGE = "bwrap not found — read-only mode requested but unavailable";

interface SshShimConfig {
	mode: BashReadonlySshPolicyMode;
	realSshPath: string;
	shimPath: string;
	sandboxRealSshPath: string;
}

/** Shell-escape a string by wrapping in single quotes. */
function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function resolveSshShimConfig(mode: BashReadonlySshPolicyMode): SshShimConfig | undefined {
	if (mode === "off") return undefined;
	const shimPath = fileURLToPath(new URL("./ssh-shim.js", import.meta.url));
	if (!existsSync(shimPath)) {
		console.warn("[pi-bash-readonly] ssh-shim.js not found — ssh policy unavailable");
		return undefined;
	}
	try {
		const realSshPath = execSync("command -v ssh", { encoding: "utf-8" }).trim();
		if (!realSshPath) {
			console.warn("[pi-bash-readonly] ssh not found — ssh policy unavailable");
			return undefined;
		}
		return {
			mode,
			realSshPath,
			shimPath,
			sandboxRealSshPath: "/run/pi-bash-readonly/real-ssh",
		};
	} catch {
		console.warn("[pi-bash-readonly] ssh not found — ssh policy unavailable");
		return undefined;
	}
}

/**
 * Build a bwrap command that runs the given command in a read-only sandbox.
 * No temp files — uses `bash -c` with proper shell escaping.
 */
export function buildBwrapCommand(
	command: string,
	cwd: string,
	writablePaths: string[],
	options?: { network?: boolean },
	sshShimConfig?: SshShimConfig,
): string {
	const parts = [
		"bwrap",
		"--die-with-parent",
		"--ro-bind / /",
		"--dev /dev",
		"--proc /proc",
	];

	// Network is isolated by default (--unshare-net)
	if (!options?.network) {
		parts.push("--unshare-net");
	}

	for (const p of writablePaths) {
		if (p === "/tmp") {
			parts.push("--tmpfs /tmp");
		} else {
			parts.push(`--bind ${shellEscape(p)} ${shellEscape(p)}`);
		}
	}

	if (sshShimConfig) {
		parts.push("--dir /run/pi-bash-readonly");
		parts.push(`--ro-bind ${shellEscape(sshShimConfig.realSshPath)} ${shellEscape(sshShimConfig.sandboxRealSshPath)}`);
		parts.push(`--ro-bind ${shellEscape(sshShimConfig.shimPath)} ${shellEscape(sshShimConfig.realSshPath)}`);
		parts.push(`--setenv PI_BASH_RO_REAL_SSH ${shellEscape(sshShimConfig.sandboxRealSshPath)}`);
		parts.push(`--setenv PI_BASH_RO_SSH_POLICY ${shellEscape(sshShimConfig.mode)}`);
		parts.push(`--setenv PI_BASH_RO_WRITABLE_PATHS ${shellEscape(JSON.stringify(writablePaths))}`);
		parts.push(`--setenv PI_BASH_RO_NETWORK ${shellEscape(options?.network ? "1" : "0")}`);
	}

	parts.push(`--chdir ${shellEscape(cwd)}`);
	parts.push(`bash -c ${shellEscape(command)}`);

	return parts.join(" ");
}

/**
 * Find the .pi directory by walking up from startDir.
 */
function findPiDir(startDir: string): string | null {
	let dir = startDir;
	while (true) {
		const candidate = join(dir, ".pi");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Load agentPaths from .pi/agents.json (same format as pi-agents config).
 */
function loadAgentPaths(cwd: string): string[] {
	const piDir = findPiDir(cwd);
	if (!piDir) return [];
	const configPath = join(piDir, "agents.json");
	if (!existsSync(configPath)) return [];
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return Array.isArray(raw.agentPaths) ? raw.agentPaths : [];
	} catch {
		return [];
	}
}

/**
 * Find the file path for a named agent.
 * Searches `.pi/agents/` first, then `agentPaths` in order.
 */
function findAgentFile(cwd: string, name: string): string | null {
	const piDir = findPiDir(cwd);

	// Standard path: .pi/agents/
	if (piDir) {
		const standardPath = join(piDir, "agents", `${name}.md`);
		if (existsSync(standardPath)) return standardPath;
	}

	// Extra paths from config
	const agentPaths = loadAgentPaths(cwd);
	for (const p of agentPaths) {
		const dir = isAbsolute(p) ? p : join(cwd, p);
		const filePath = join(dir, `${name}.md`);
		if (existsSync(filePath)) return filePath;
	}

	return null;
}

/**
 * Determine initial sandbox state from agent frontmatter or config.
 *
 * Priority:
 * 1. Agent frontmatter `bash-readonly` (if PI_AGENT is set and agent file found)
 * 2. Config file `enabled` field
 * 3. Default: true (sandboxed)
 */
function getInitialState(cwd: string, config: { enabled?: boolean }): { readOnly: boolean; locked: boolean } {
	const agentName = process.env.PI_AGENT;
	if (agentName && agentName !== "none") {
		const agentFile = findAgentFile(cwd, agentName);
		if (agentFile) {
			try {
				const { data } = matter(readFileSync(agentFile, "utf-8"));
				if (typeof data["bash-readonly"] === "boolean") {
					return {
						readOnly: data["bash-readonly"],
						locked: data["bash-readonly-locked"] === true,
					};
				}
			} catch {
				// Failed to parse agent file, fall through to config
			}
		}
	}

	// Fall back to config file
	return { readOnly: config.enabled ?? true, locked: false };
}

function createUnavailableBashOps(message: string): BashOperations {
	return {
		exec: async () => {
			throw new Error(message);
		},
	};
}

/**
 * Create BashOperations that wrap commands in bwrap.
 */
function createSandboxedBashOps(
	cwd: string,
	writablePaths: string[],
	bwrapOptions?: { network?: boolean },
	sshShimConfig?: SshShimConfig,
): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec(command, execCwd, options) {
			const wrapped = buildBwrapCommand(command, execCwd, writablePaths, bwrapOptions, sshShimConfig);
			return local.exec(wrapped, cwd, options);
		},
	};
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
		console.warn("[pi-bash-readonly] bwrap not found — read-only mode will fail closed when enabled");
	}

	if (config.execution.type !== "local") {
		console.warn(`[pi-bash-readonly] execution.type=${config.execution.type} is not implemented yet — using local execution`);
	}

	// Resolve writable paths, skip non-existent ones
	const writablePaths = config.sandbox.writable.filter((p) => {
		if (!existsSync(p)) {
			console.warn(`[pi-bash-readonly] writable path does not exist, skipping: ${p}`);
			return false;
		}
		return true;
	});

	const sshShimConfig = resolveSshShimConfig(config.sshPolicy.mode);
	const sshPolicyUnavailable = config.sandbox.network && config.sshPolicy.mode !== "off" && !sshShimConfig
		? "ssh policy requires a working ssh shim when sandbox.network=true"
		: undefined;

	// Determine initial state from agent frontmatter or config
	const initialState = getInitialState(cwd, config);
	let readOnly = initialState.readOnly;
	const locked = initialState.locked;

	// Create both tool variants
	const localBash = createBashTool(cwd);
	const bwrapOptions = { network: config.sandbox.network };
	const sandboxedBash = createBashTool(cwd, {
		spawnHook: ({ command, cwd: spawnCwd, env }) => ({
			command: buildBwrapCommand(command, spawnCwd, writablePaths, bwrapOptions, sshShimConfig),
			cwd: spawnCwd,
			env,
		}),
	});

	// Register the bash tool with dynamic dispatch
	pi.registerTool({
		...localBash,

		renderCall(args: { command: string; timeout?: number }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const lock = readOnly ? theme.fg("accent", "🔒 ") : "";
			const content = `${lock}${theme.fg("toolTitle", theme.bold("bash "))}${theme.fg("muted", args.command ?? "")}`;
			text.setText(content);
			return text;
		},

		// renderResult omitted — inherits built-in bash renderer

		async execute(id, params, signal, onUpdate, _ctx) {
			if (readOnly && !hasBwrap) {
				throw new Error(MISSING_BWRAP_MESSAGE);
			}
			if (readOnly && sshPolicyUnavailable) {
				throw new Error(`[pi-bash-readonly] ${sshPolicyUnavailable}`);
			}
			const tool = readOnly ? sandboxedBash : localBash;
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// Sandbox user_bash (! and !! commands) when active
	pi.on("user_bash", (_event) => {
		if (!readOnly) return;
		if (!hasBwrap) {
			return { operations: createUnavailableBashOps(MISSING_BWRAP_MESSAGE) };
		}
		if (sshPolicyUnavailable) {
			return { operations: createUnavailableBashOps(`[pi-bash-readonly] ${sshPolicyUnavailable}`) };
		}
		return { operations: createSandboxedBashOps(cwd, writablePaths, bwrapOptions, sshShimConfig) };
	});

	// Register /readonly toggle command
	pi.registerCommand("readonly", {
		description: "Toggle read-only bash (bwrap sandbox)",
		handler: async (_args, ctx) => {
			if (!hasBwrap) {
				ctx.ui.notify("bwrap not found — read-only mode unavailable", "error");
				return;
			}
			if (locked) {
				ctx.ui.notify("🔒 bash read-only mode is locked by agent config", "warning");
				return;
			}
			readOnly = !readOnly;
			ctx.ui.notify(readOnly ? "🔒 bash: read-only (bwrap)" : "🔓 bash: full access", "info");
			ctx.ui.setStatus("bash-ro", readOnly ? "🔒 ro" : "");
		},
	});

	// Set initial status indicator
	pi.on("session_start", async (_event, ctx) => {
		if (readOnly && hasBwrap) {
			ctx.ui.setStatus("bash-ro", "🔒 ro");
		}
		if (readOnly && !hasBwrap) {
			ctx.ui.notify(MISSING_BWRAP_MESSAGE, "error");
		}
		if (readOnly && sshPolicyUnavailable) {
			ctx.ui.notify(`[pi-bash-readonly] ${sshPolicyUnavailable}`, "error");
		}
	});
}
