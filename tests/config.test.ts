import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, mergeConfigLayers, normalizeConfigLayer } from "../config.js";

describe("loadConfig", () => {
	let dir: string;
	let warnings: string[];
	const originalWarn = console.warn;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bash-ro-config-"));
		warnings = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.warn = originalWarn;
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns normalized defaults when no config file exists", () => {
		const config = loadConfig(dir, { projectConfigPath: null, userConfigPath: null });
		expect(config).toEqual({
			enabled: undefined,
			execution: { type: "local" },
			sandbox: {
				writable: [],
				network: false,
			},
			sshPolicy: {
				mode: "require-remote-bwrap",
			},
		});
		expect(warnings).toEqual([]);
	});

	it("loads legacy project config into the normalized shape", () => {
		const projectPath = join(dir, "project.json");
		writeFileSync(projectPath, JSON.stringify({
			enabled: false,
			writable: ["/tmp", "/var/data"],
			network: true,
		}));

		const config = loadConfig(dir, { projectConfigPath: projectPath, userConfigPath: null });
		expect(config).toEqual({
			enabled: false,
			execution: { type: "local" },
			sandbox: {
				writable: ["/tmp", "/var/data"],
				network: true,
			},
			sshPolicy: {
				mode: "require-remote-bwrap",
			},
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("deprecated config keys");
	});

	it("loads structured config", () => {
		const projectPath = join(dir, "project.json");
		writeFileSync(projectPath, JSON.stringify({
			enabled: true,
			execution: { type: "local" },
			sandbox: {
				writable: ["/tmp"],
				network: true,
			},
			sshPolicy: {
				mode: "off",
			},
		}));

		const config = loadConfig(dir, { projectConfigPath: projectPath, userConfigPath: null });
		expect(config).toEqual({
			enabled: true,
			execution: { type: "local" },
			sandbox: {
				writable: ["/tmp"],
				network: true,
			},
			sshPolicy: {
				mode: "off",
			},
		});
		expect(warnings).toEqual([]);
	});

	it("supports ssh execution config in the normalized shape", () => {
		const projectPath = join(dir, "project.json");
		writeFileSync(projectPath, JSON.stringify({
			execution: {
				type: "ssh",
				host: "user@example.com",
				cwd: "/work/project",
				args: ["-p", "2222", 123],
			},
		}));

		const config = loadConfig(dir, { projectConfigPath: projectPath, userConfigPath: null });
		expect(config.execution).toEqual({
			type: "ssh",
			host: "user@example.com",
			cwd: "/work/project",
			args: ["-p", "2222"],
		});
		expect(config.sandbox.network).toBe(false);
	});

	it("applies per-layer precedence after normalizing each layer", () => {
		const userPath = join(dir, "user.json");
		const projectPath = join(dir, "project.json");
		writeFileSync(userPath, JSON.stringify({
			writable: ["/tmp"],
			network: true,
		}));
		writeFileSync(projectPath, JSON.stringify({
			enabled: false,
			sandbox: {
				writable: ["/var/data"],
			},
		}));

		const config = loadConfig(dir, { projectConfigPath: projectPath, userConfigPath: userPath });
		expect(config).toEqual({
			enabled: false,
			execution: { type: "local" },
			sandbox: {
				writable: ["/var/data"],
				network: true,
			},
			sshPolicy: {
				mode: "require-remote-bwrap",
			},
		});
		expect(warnings).toHaveLength(1);
	});

	it("handles malformed JSON gracefully", () => {
		const projectPath = join(dir, "project.json");
		writeFileSync(projectPath, "not json{{{");

		const config = loadConfig(dir, { projectConfigPath: projectPath, userConfigPath: null });
		expect(config.sandbox.writable).toEqual([]);
		expect(config.enabled).toBeUndefined();
		expect(warnings).toEqual([]);
	});
});

describe("normalizeConfigLayer", () => {
	it("filters non-string writable entries", () => {
		const result = normalizeConfigLayer({
			sandbox: {
				writable: ["/tmp", 123, null, "/var"],
			},
		}, "test");
		expect(result.layer.sandbox?.writable).toEqual(["/tmp", "/var"]);
	});

	it("warns when mixing legacy and structured keys, with structured values winning", () => {
		const result = normalizeConfigLayer({
			writable: ["/tmp"],
			network: true,
			sandbox: {
				writable: ["/var/data"],
				network: false,
			},
		}, "test-config");

		expect(result.layer.sandbox).toEqual({
			writable: ["/var/data"],
			network: false,
		});
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain("deprecated config keys");
		expect(result.warnings[0]).toContain("test-config");
		expect(result.warnings[1]).toContain("mixed config styles");
	});

	it("ignores invalid sshPolicy values", () => {
		const result = normalizeConfigLayer({
			sshPolicy: {
				mode: "invalid-mode",
			},
		}, "test");
		expect(result.layer.sshPolicy).toBeUndefined();
		expect(result.warnings).toEqual([]);
	});
});

describe("mergeConfigLayers", () => {
	it("merges normalized layers over the default config", () => {
		const config = mergeConfigLayers(
			{
				sandbox: {
					writable: ["/tmp"],
					network: true,
				},
			},
			{
				enabled: false,
				sshPolicy: {
					mode: "off",
				},
			},
		);

		expect(config).toEqual({
			enabled: false,
			execution: { type: "local" },
			sandbox: {
				writable: ["/tmp"],
				network: true,
			},
			sshPolicy: {
				mode: "off",
			},
		});
	});
});
