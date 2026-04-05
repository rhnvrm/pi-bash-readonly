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

export interface BashReadonlyConfig {
	/** Paths that should be writable inside the sandbox. Default: [] */
	writable: string[];
	/** Initial sandbox state. Overridden by agent frontmatter. Default: true */
	enabled?: boolean;
	/** Allow network access inside the sandbox. Default: false (network isolated) */
	network?: boolean;
}

const DEFAULT_CONFIG: BashReadonlyConfig = {
	writable: [],
};

function readJsonFile(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
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

export function loadConfig(cwd: string): BashReadonlyConfig {
	const piDir = findPiDir(cwd);
	const projectPath = piDir ? join(piDir, "pi-bash-readonly.json") : null;
	const userPath = join(homedir(), ".pi", "agent", "pi-bash-readonly.json");

	let merged: Record<string, unknown> = { ...DEFAULT_CONFIG };

	// Layer 2: user config
	const userConfig = readJsonFile(userPath);
	if (userConfig) {
		merged = { ...merged, ...userConfig };
	}

	// Layer 1: project config (highest priority)
	if (projectPath) {
		const projectConfig = readJsonFile(projectPath);
		if (projectConfig) {
			merged = { ...merged, ...projectConfig };
		}
	}

	return {
		writable: Array.isArray(merged.writable) ? merged.writable.filter((p) => typeof p === "string") : [],
		enabled: typeof merged.enabled === "boolean" ? merged.enabled : undefined,
		network: typeof merged.network === "boolean" ? merged.network : false,
	};
}
