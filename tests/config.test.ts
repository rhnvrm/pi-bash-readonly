import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bash-ro-config-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns defaults when no config file exists", () => {
		const config = loadConfig(dir);
		expect(config.writable).toEqual([]);
	});

	it("loads writable paths from project config", () => {
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "pi-bash-readonly.json"), JSON.stringify({
			writable: ["/tmp", "/var/data"],
		}));
		const config = loadConfig(dir);
		expect(config.writable).toEqual(["/tmp", "/var/data"]);
	});

	it("handles malformed JSON gracefully", () => {
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "pi-bash-readonly.json"), "not json{{{");
		const config = loadConfig(dir);
		expect(config.writable).toEqual([]);
	});

	it("filters non-string entries from writable", () => {
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "pi-bash-readonly.json"), JSON.stringify({
			writable: ["/tmp", 123, null, "/var"],
		}));
		const config = loadConfig(dir);
		expect(config.writable).toEqual(["/tmp", "/var"]);
	});

	it("defaults writable to [] when set to non-array", () => {
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "pi-bash-readonly.json"), JSON.stringify({
			writable: "not an array",
		}));
		const config = loadConfig(dir);
		expect(config.writable).toEqual([]);
	});
});
