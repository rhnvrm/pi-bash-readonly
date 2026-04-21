/**
 * Pi Bash Readonly - Configuration
 *
 * Priority (highest to lowest):
 * 1. Agent frontmatter: bash-readonly / bash-readonly-locked
 * 2. Project: .pi/pi-bash-readonly.json
 * 3. User: ~/.pi/agent/pi-bash-readonly.json
 * 4. Defaults
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type BashReadonlySshPolicyMode = "off" | "require-remote-bwrap";

export interface BashReadonlyExecutionLocalConfig {
	type: "local";
}

export interface BashReadonlyExecutionSshConfig {
	type: "ssh";
	host: string;
	cwd?: string;
	args: string[];
}

export type BashReadonlyExecutionConfig = BashReadonlyExecutionLocalConfig | BashReadonlyExecutionSshConfig;

export interface LegacyBashReadonlyConfig {
	/** Initial sandbox state. Overridden by agent frontmatter. */
	enabled?: boolean;
	/** @deprecated Use sandbox.writable instead. */
	writable?: string[];
	/** @deprecated Use sandbox.network instead. */
	network?: boolean;
}

export interface StructuredBashReadonlyConfig {
	/** Initial sandbox state. Overridden by agent frontmatter. */
	enabled?: boolean;
	execution?:
		| { type: "local" }
		| {
				type: "ssh";
				host: string;
				cwd?: string;
				args?: string[];
		  };
	sandbox?: {
		writable?: string[];
		network?: boolean;
	};
	sshPolicy?: {
		mode?: BashReadonlySshPolicyMode;
	};
}

export interface BashReadonlyConfigLayer {
	enabled?: boolean;
	execution?: BashReadonlyExecutionConfig;
	sandbox?: {
		writable?: string[];
		network?: boolean;
	};
	sshPolicy?: {
		mode?: BashReadonlySshPolicyMode;
	};
}

export interface BashReadonlyConfig {
	/** Initial sandbox state. Overridden by agent frontmatter. */
	enabled?: boolean;
	execution: BashReadonlyExecutionConfig;
	sandbox: {
		writable: string[];
		network: boolean;
	};
	sshPolicy: {
		mode: BashReadonlySshPolicyMode;
	};
}

export interface NormalizeConfigLayerResult {
	layer: BashReadonlyConfigLayer;
	warnings: string[];
}

export interface LoadConfigOptions {
	projectConfigPath?: string | null;
	userConfigPath?: string | null;
}

const DEFAULT_CONFIG: BashReadonlyConfig = {
	execution: { type: "local" },
	sandbox: {
		writable: [],
		network: false,
	},
	sshPolicy: {
		mode: "require-remote-bwrap",
	},
};

function readJsonFile(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function parseExecutionConfig(value: unknown): BashReadonlyExecutionConfig | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.type === "local") {
		return { type: "local" };
	}
	if (value.type === "ssh" && typeof value.host === "string") {
		return {
			type: "ssh",
			host: value.host,
			cwd: typeof value.cwd === "string" ? value.cwd : undefined,
			args: parseStringArray(value.args) ?? [],
		};
	}
	return undefined;
}

function parseSshPolicy(value: unknown): BashReadonlyConfigLayer["sshPolicy"] | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.mode === "off" || value.mode === "require-remote-bwrap") {
		return { mode: value.mode };
	}
	return undefined;
}

function formatConfigSource(source: string): string {
	return source ? ` (${source})` : "";
}

export function normalizeConfigLayer(raw: Record<string, unknown> | null, source = "config"): NormalizeConfigLayerResult {
	if (!raw) {
		return { layer: {}, warnings: [] };
	}

	const warnings: string[] = [];
	const usesLegacyKeys = "writable" in raw || "network" in raw;
	const usesStructuredKeys = "execution" in raw || "sandbox" in raw || "sshPolicy" in raw;
	const sourceLabel = formatConfigSource(source);

	if (usesLegacyKeys) {
		warnings.push(
			`[pi-bash-readonly] deprecated config keys${sourceLabel}: top-level \`writable\`/\`network\` are deprecated; use \`sandbox.writable\`/\`sandbox.network\` instead.`,
		);
	}

	if (usesLegacyKeys && usesStructuredKeys) {
		warnings.push(
			`[pi-bash-readonly] mixed config styles${sourceLabel}: structured keys take precedence over top-level \`writable\`/\`network\`.`,
		);
	}

	const sandbox = isPlainObject(raw.sandbox) ? raw.sandbox : undefined;
	const structuredWritable = parseStringArray(sandbox?.writable);
	const structuredNetwork = typeof sandbox?.network === "boolean" ? sandbox.network : undefined;
	const legacyWritable = parseStringArray(raw.writable);
	const legacyNetwork = typeof raw.network === "boolean" ? raw.network : undefined;

	const layer: BashReadonlyConfigLayer = {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
		execution: parseExecutionConfig(raw.execution),
		sshPolicy: parseSshPolicy(raw.sshPolicy),
	};

	const writable = structuredWritable ?? legacyWritable;
	const network = structuredNetwork ?? legacyNetwork;
	if (writable !== undefined || network !== undefined) {
		layer.sandbox = {
			writable,
			network,
		};
	}

	return { layer, warnings };
}

export function mergeConfigLayers(...layers: BashReadonlyConfigLayer[]): BashReadonlyConfig {
	let merged: BashReadonlyConfig = {
		enabled: DEFAULT_CONFIG.enabled,
		execution: { ...DEFAULT_CONFIG.execution },
		sandbox: { ...DEFAULT_CONFIG.sandbox },
		sshPolicy: { ...DEFAULT_CONFIG.sshPolicy },
	};

	for (const layer of layers) {
		merged = {
			enabled: layer.enabled ?? merged.enabled,
			execution: layer.execution ?? merged.execution,
			sandbox: {
				writable: layer.sandbox?.writable ?? merged.sandbox.writable,
				network: layer.sandbox?.network ?? merged.sandbox.network,
			},
			sshPolicy: {
				mode: layer.sshPolicy?.mode ?? merged.sshPolicy.mode,
			},
		};
	}

	return merged;
}

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

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): BashReadonlyConfig {
	const piDir = findPiDir(cwd);
	const projectPath = options.projectConfigPath === undefined ? (piDir ? join(piDir, "pi-bash-readonly.json") : null) : options.projectConfigPath;
	const userPath = options.userConfigPath === undefined ? join(homedir(), ".pi", "agent", "pi-bash-readonly.json") : options.userConfigPath;

	const userRaw = userPath ? readJsonFile(userPath) : null;
	const projectRaw = projectPath ? readJsonFile(projectPath) : null;

	const userLayer = normalizeConfigLayer(userRaw, userPath ?? "user config");
	const projectLayer = normalizeConfigLayer(projectRaw, projectPath ?? "project config");

	for (const warning of [...userLayer.warnings, ...projectLayer.warnings]) {
		console.warn(warning);
	}

	return mergeConfigLayers(userLayer.layer, projectLayer.layer);
}
