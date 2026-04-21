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
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type {
	BashReadonlyExecutionSshConfig,
	BashReadonlySshPolicyMode,
} from "../config.js";
import { loadConfig } from "../config.js";

const MISSING_BWRAP_MESSAGE = "bwrap not found — read-only mode requested but unavailable";
const STERILE_SSH_ARGS = Object.freeze([
	"-F", "/dev/null",
	"-T",
	"-o", "BatchMode=yes",
	"-o", "ClearAllForwardings=yes",
	"-o", "PermitLocalCommand=no",
	"-o", "ProxyCommand=none",
]);
const SSH_FLAGS_WITH_VALUE = new Set(["-i", "-l", "-o", "-p"]);
const SSH_FLAGS_NO_VALUE = new Set(["-4", "-6", "-A", "-a", "-C", "-q", "-T", "-v", "-vv", "-vvv"]);
const SSH_FLAGS_REJECTED = new Set(["-D", "-F", "-f", "-G", "-J", "-L", "-M", "-N", "-O", "-R", "-S", "-s", "-W", "-w"]);
const SSH_O_OPTION_WHITELIST = new Set([
	"BatchMode",
	"ConnectTimeout",
	"IdentityFile",
	"IdentitiesOnly",
	"LogLevel",
	"Port",
	"StrictHostKeyChecking",
	"User",
	"UserKnownHostsFile",
]);

interface SshShimConfig {
	mode: BashReadonlySshPolicyMode;
	realSshPath: string;
	shimPath: string;
	sandboxRealSshPath: string;
}

interface RemoteExecutionState {
	sshPath: string;
	host: string;
	sshArgs: string[];
	configuredRemoteCwd?: string;
	resolvedRemoteCwd?: string;
	resolvedRemoteCwdPromise?: Promise<string>;
	remoteBwrapVerified: boolean;
	remoteBwrapVerifyPromise?: Promise<void>;
	getReadOnly: () => boolean;
}

interface RemoteSshExecResult {
	exitCode: number;
	stdout: Buffer;
	stderr: Buffer;
}

/** Shell-escape a string by wrapping in single quotes. */
function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function resolveRealSshPath(): string | undefined {
	try {
		const realSshPath = execSync("command -v ssh", { encoding: "utf-8" }).trim();
		return realSshPath || undefined;
	} catch {
		return undefined;
	}
}

function resolveSshShimConfig(mode: BashReadonlySshPolicyMode): SshShimConfig | undefined {
	if (mode === "off") return undefined;
	const shimPath = fileURLToPath(new URL("./ssh-shim.js", import.meta.url));
	if (!existsSync(shimPath)) {
		console.warn("[pi-bash-readonly] ssh-shim.js not found — ssh policy unavailable");
		return undefined;
	}
	const realSshPath = resolveRealSshPath();
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
}

export function buildSterileSshArgs(args: string[] = []): string[] {
	return [...STERILE_SSH_ARGS, ...args];
}

function getSshOptionKey(value: string): string {
	const [key] = value.split("=", 1);
	return key;
}

function isAllowedSshOption(value: string): boolean {
	return SSH_O_OPTION_WHITELIST.has(getSshOptionKey(value));
}

export function sanitizeConfiguredSshArgs(args: string[]): string[] {
	const passthrough: string[] = [];
	let index = 0;

	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") {
			throw new Error("configured ssh args do not support '--' passthrough");
		}
		if (SSH_FLAGS_REJECTED.has(arg)) {
			throw new Error(`unsupported configured ssh arg: ${arg}`);
		}
		if (SSH_FLAGS_NO_VALUE.has(arg)) {
			passthrough.push(arg);
			index += 1;
			continue;
		}
		if (SSH_FLAGS_WITH_VALUE.has(arg)) {
			const value = args[index + 1];
			if (value === undefined) {
				throw new Error(`configured ssh arg requires a value: ${arg}`);
			}
			if (arg === "-o" && !isAllowedSshOption(value)) {
				throw new Error(`unsupported configured ssh -o option: ${value}`);
			}
			passthrough.push(arg, value);
			index += 2;
			continue;
		}
		throw new Error(`configured execution.args must contain only ssh option flags; found: ${arg}`);
	}

	return passthrough;
}

export function validateConfiguredSshHost(host: string): string {
	const normalizedHost = host.trim();
	if (!normalizedHost) {
		throw new Error("configured remote bash requires a non-empty execution.host");
	}
	if (normalizedHost.startsWith("-")) {
		throw new Error("configured remote bash execution.host must not start with '-'");
	}
	if (/\s/.test(normalizedHost)) {
		throw new Error("configured remote bash execution.host must not contain whitespace");
	}
	return normalizedHost;
}

export function mapLocalToRemoteCwd(localRoot: string, execCwd: string, remoteRoot: string): string {
	const rel = relative(localRoot, execCwd);
	if (!rel || rel === "") return remoteRoot;
	if (rel === "." || rel.startsWith(`..${sep}`) || rel === "..") {
		return remoteRoot;
	}
	return posix.join(remoteRoot, ...rel.split(sep));
}

function buildRemoteReadonlyCommand(
	remoteCommand: string,
	writablePaths: string[],
	options?: { network?: boolean },
): string {
	const parts = [
		"exec bwrap",
		"--die-with-parent",
		"--ro-bind / /",
		"--dev /dev",
		"--proc /proc",
	];

	if (!options?.network) {
		parts.push("--unshare-net");
	}

	for (const writablePath of writablePaths) {
		if (writablePath === "/tmp") {
			parts.push("--tmpfs /tmp");
		} else {
			parts.push(`--bind ${shellEscape(writablePath)} ${shellEscape(writablePath)}`);
		}
	}

	parts.push(`bash -lc ${shellEscape(remoteCommand)}`);
	return parts.join(" ");
}

export function buildRemoteExecutionCommand(
	command: string,
	remoteCwd: string,
	readOnly: boolean,
	writablePaths: string[],
	options?: { network?: boolean },
): string {
	const baseCommand = `cd ${shellEscape(remoteCwd)} && ${command}`;
	if (!readOnly) {
		return baseCommand;
	}
	return buildRemoteReadonlyCommand(baseCommand, writablePaths, options);
}

function execSshCommand(
	sshPath: string,
	sshArgs: string[],
	options: {
		onData?: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
	} = {},
): Promise<RemoteSshExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(sshPath, sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		const timeoutHandle = options.timeout && options.timeout > 0
			? setTimeout(() => {
				timedOut = true;
				child.kill();
			}, options.timeout * 1000)
			: undefined;

		child.stdout?.on("data", (data: Buffer) => {
			stdoutChunks.push(data);
			options.onData?.(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderrChunks.push(data);
			options.onData?.(data);
		});
		child.on("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});

		const onAbort = () => child.kill();
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			if (timedOut) {
				reject(new Error(`timeout:${options.timeout}`));
				return;
			}
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
			});
		});
	});
}

async function resolveRemoteBaseCwd(
	state: RemoteExecutionState,
	execOptions?: { signal?: AbortSignal; timeout?: number },
): Promise<string> {
	if (state.resolvedRemoteCwd) {
		return state.resolvedRemoteCwd;
	}
	if (state.configuredRemoteCwd) {
		state.resolvedRemoteCwd = state.configuredRemoteCwd;
		return state.resolvedRemoteCwd;
	}
	if (!state.resolvedRemoteCwdPromise) {
		state.resolvedRemoteCwdPromise = (async () => {
			const result = await execSshCommand(
				state.sshPath,
				buildSterileSshArgs([...state.sshArgs, state.host, "pwd"]),
				{
					signal: execOptions?.signal,
					timeout: execOptions?.timeout,
				},
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`[pi-bash-readonly] failed to resolve configured remote cwd for ${state.host}: ${result.stderr.toString("utf-8").trim() || `exit ${result.exitCode}`}`,
				);
			}
			const remoteCwd = result.stdout.toString("utf-8").trim();
			if (!remoteCwd) {
				throw new Error(`[pi-bash-readonly] failed to resolve configured remote cwd for ${state.host}: empty pwd result`);
			}
			state.resolvedRemoteCwd = remoteCwd;
			return remoteCwd;
		})();
	}
	try {
		return await state.resolvedRemoteCwdPromise;
	} catch (error) {
		state.resolvedRemoteCwdPromise = undefined;
		throw error;
	}
}

async function ensureRemoteBwrap(
	state: RemoteExecutionState,
	execOptions?: { signal?: AbortSignal; timeout?: number },
): Promise<void> {
	if (state.remoteBwrapVerified) return;
	if (!state.remoteBwrapVerifyPromise) {
		state.remoteBwrapVerifyPromise = (async () => {
			const probe = await execSshCommand(
				state.sshPath,
				buildSterileSshArgs([...state.sshArgs, state.host, "command -v bwrap >/dev/null 2>&1"]),
				{
					signal: execOptions?.signal,
					timeout: execOptions?.timeout,
				},
			);
			if (probe.exitCode !== 0) {
				throw new Error(`[pi-bash-readonly] remote bwrap probe failed for ${state.host}; refusing configured remote bash without confirmed remote bwrap`);
			}
			state.remoteBwrapVerified = true;
		})();
	}
	try {
		await state.remoteBwrapVerifyPromise;
	} catch (error) {
		state.remoteBwrapVerifyPromise = undefined;
		throw error;
	}
}

export function createRemoteBashOperations(options: {
	localCwd: string;
	sshPath: string;
	execution: BashReadonlyExecutionSshConfig;
	writablePaths: string[];
	network: boolean;
	getReadOnly: () => boolean;
}): BashOperations {
	const state: RemoteExecutionState = {
		sshPath: options.sshPath,
		host: validateConfiguredSshHost(options.execution.host),
		sshArgs: sanitizeConfiguredSshArgs(options.execution.args),
		configuredRemoteCwd: options.execution.cwd,
		remoteBwrapVerified: false,
		getReadOnly: options.getReadOnly,
	};

	return {
		async exec(command, execCwd, execOptions) {
			const readOnly = state.getReadOnly();
			const preflightOptions = {
				signal: execOptions.signal,
				timeout: execOptions.timeout,
			};
			const remoteBaseCwd = await resolveRemoteBaseCwd(state, preflightOptions);
			const remoteExecCwd = mapLocalToRemoteCwd(options.localCwd, execCwd, remoteBaseCwd);

			if (readOnly) {
				await ensureRemoteBwrap(state, preflightOptions);
			}

			const remoteCommand = buildRemoteExecutionCommand(
				command,
				remoteExecCwd,
				readOnly,
				options.writablePaths,
				{ network: options.network },
			);
			const result = await execSshCommand(
				options.sshPath,
				buildSterileSshArgs([...state.sshArgs, state.host, remoteCommand]),
				{
					onData: execOptions.onData,
					signal: execOptions.signal,
					timeout: execOptions.timeout,
				},
			);
			return { exitCode: result.exitCode };
		},
	};
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
	const remoteExecutionConfig = config.execution.type === "ssh" ? config.execution : undefined;
	const usesRemoteExecution = remoteExecutionConfig !== undefined;

	// Check if bwrap is available at load time
	let hasLocalBwrap = true;
	try {
		execSync("which bwrap", { stdio: "ignore" });
	} catch {
		hasLocalBwrap = false;
		console.warn("[pi-bash-readonly] bwrap not found — read-only mode will fail closed when enabled");
	}

	// Resolve writable paths for local execution, but keep configured remote paths intact.
	const writablePaths = usesRemoteExecution
		? config.sandbox.writable
		: config.sandbox.writable.filter((p) => {
			if (!existsSync(p)) {
				console.warn(`[pi-bash-readonly] writable path does not exist, skipping: ${p}`);
				return false;
			}
			return true;
		});

	// Determine initial state from agent frontmatter or config
	const initialState = getInitialState(cwd, config);
	let readOnly = initialState.readOnly;
	const locked = initialState.locked;

	const localBash = createBashTool(cwd);
	const bwrapOptions = { network: config.sandbox.network };
	const sshShimConfig = !usesRemoteExecution ? resolveSshShimConfig(config.sshPolicy.mode) : undefined;
	const sshPolicyUnavailable = !usesRemoteExecution && config.sandbox.network && config.sshPolicy.mode !== "off" && !sshShimConfig
		? "ssh policy requires a working ssh shim when sandbox.network=true"
		: undefined;
	const sandboxedBash = createBashTool(cwd, {
		spawnHook: ({ command, cwd: spawnCwd, env }) => ({
			command: buildBwrapCommand(command, spawnCwd, writablePaths, bwrapOptions, sshShimConfig),
			cwd: spawnCwd,
			env,
		}),
	});

	let remoteExecutionError: string | undefined;
	let remoteBash: ReturnType<typeof createBashTool> | undefined;
	let remoteBashOps: BashOperations | undefined;
	if (usesRemoteExecution) {
		const realSshPath = resolveRealSshPath();
		if (!realSshPath) {
			remoteExecutionError = "configured remote bash requires ssh in PATH";
			console.warn(`[pi-bash-readonly] ${remoteExecutionError}`);
		} else {
			try {
				remoteBashOps = createRemoteBashOperations({
					localCwd: cwd,
					sshPath: realSshPath,
					execution: remoteExecutionConfig,
					writablePaths,
					network: config.sandbox.network,
					getReadOnly: () => readOnly,
				});
				remoteBash = createBashTool(cwd, { operations: remoteBashOps });
			} catch (error) {
				remoteExecutionError = error instanceof Error ? error.message : String(error);
				console.warn(`[pi-bash-readonly] ${remoteExecutionError}`);
			}
		}
	}

	// Register the bash tool with dynamic dispatch
	pi.registerTool({
		...localBash,

		renderCall(args: { command: string; timeout?: number }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const lock = readOnly ? theme.fg("accent", "🔒 ") : "";
			const remote = remoteExecutionConfig ? theme.fg("muted", `↗ ${remoteExecutionConfig.host} `) : "";
			const content = `${lock}${remote}${theme.fg("toolTitle", theme.bold("bash "))}${theme.fg("muted", args.command ?? "")}`;
			text.setText(content);
			return text;
		},

		// renderResult omitted — inherits built-in bash renderer

		async execute(id, params, signal, onUpdate, _ctx) {
			if (usesRemoteExecution) {
				if (remoteExecutionError || !remoteBash) {
					throw new Error(`[pi-bash-readonly] ${remoteExecutionError ?? "configured remote bash is unavailable"}`);
				}
				return remoteBash.execute(id, params, signal, onUpdate);
			}
			if (readOnly && !hasLocalBwrap) {
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
		if (usesRemoteExecution) {
			if (remoteExecutionError || !remoteBashOps) {
				return {
					operations: createUnavailableBashOps(
						`[pi-bash-readonly] ${remoteExecutionError ?? "configured remote bash is unavailable"}`,
					),
				};
			}
			return { operations: remoteBashOps };
		}
		if (!readOnly) return;
		if (!hasLocalBwrap) {
			return { operations: createUnavailableBashOps(MISSING_BWRAP_MESSAGE) };
		}
		if (sshPolicyUnavailable) {
			return { operations: createUnavailableBashOps(`[pi-bash-readonly] ${sshPolicyUnavailable}`) };
		}
		return { operations: createSandboxedBashOps(cwd, writablePaths, bwrapOptions, sshShimConfig) };
	});

	pi.on("before_agent_start", async (event) => {
		if (!remoteExecutionConfig) return;
		const remoteTarget = remoteExecutionConfig.cwd
			? `${remoteExecutionConfig.host}:${remoteExecutionConfig.cwd}`
			: `${remoteExecutionConfig.host} (remote cwd resolved at runtime)`;
		return {
			systemPrompt: `${event.systemPrompt}\n\nBash execution mode: configured remote SSH. The bash tool runs on ${remoteTarget}. File tools such as read, grep, find, ls, edit, and write remain local under ${cwd}. Do not assume bash changes affect local files unless the remote path is intentionally mirrored.`,
		};
	});

	// Register /readonly toggle command
	pi.registerCommand("readonly", {
		description: "Toggle read-only bash (bwrap sandbox)",
		handler: async (_args, ctx) => {
			if (!usesRemoteExecution && !hasLocalBwrap) {
				ctx.ui.notify("bwrap not found — read-only mode unavailable", "error");
				return;
			}
			if (locked) {
				ctx.ui.notify("🔒 bash read-only mode is locked by agent config", "warning");
				return;
			}
			readOnly = !readOnly;
			const modeLabel = usesRemoteExecution ? " (remote ssh)" : "";
			ctx.ui.notify(readOnly ? `🔒 bash: read-only${modeLabel}` : `🔓 bash: full access${modeLabel}`, "info");
			ctx.ui.setStatus("bash-ro", readOnly ? "🔒 ro" : "");
		},
	});

	// Set initial status indicator
	pi.on("session_start", async (_event, ctx) => {
		if (readOnly) {
			ctx.ui.setStatus("bash-ro", "🔒 ro");
		}
		if (remoteExecutionConfig) {
			ctx.ui.setStatus("bash-ssh", `↗ ${remoteExecutionConfig.host}`);
			ctx.ui.notify(
				`bash executes remotely via SSH on ${remoteExecutionConfig.host}${remoteExecutionConfig.cwd ? `:${remoteExecutionConfig.cwd}` : ""}; file tools remain local`,
				"info",
			);
			if (remoteExecutionError) {
				ctx.ui.notify(`[pi-bash-readonly] ${remoteExecutionError}`, "error");
			}
			return;
		}
		if (readOnly && !hasLocalBwrap) {
			ctx.ui.notify(MISSING_BWRAP_MESSAGE, "error");
		}
		if (readOnly && sshPolicyUnavailable) {
			ctx.ui.notify(`[pi-bash-readonly] ${sshPolicyUnavailable}`, "error");
		}
	});
}
