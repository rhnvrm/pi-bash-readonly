import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBwrapCommand } from "../extensions/index.ts";
import { buildRemoteBwrapCommand, parseSshArgs } from "../extensions/ssh-shim.js";
import { createWritableTempDir, hasWritableTempBase } from "./temp-dir.js";

const createdDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = createWritableTempDir(prefix);
	createdDirs.push(dir);
	return dir;
}

function createFakeSshScript(dir: string): { scriptPath: string; logPath: string } {
	const logPath = join(dir, "fake-ssh.log");
	const scriptPath = join(dir, "fake-ssh.sh");
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env bash
set -euo pipefail
log_file="\${FAKE_SSH_LOG:?}"
printf 'CALL\t%s\n' "$*" >> "$log_file"
last="\${!#}"
if [[ "$last" == "command -v bwrap >/dev/null 2>&1" ]]; then
  if [[ "\${FAKE_SSH_HAS_BWRAP:-0}" == "1" ]]; then
    exit 0
  fi
  echo "missing bwrap" >&2
  exit 1
fi
printf 'REMOTE\t%s\n' "$last" >> "$log_file"
exit 0
`,
	);
	chmodSync(scriptPath, 0o755);
	return { scriptPath, logPath };
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const hasWritableTemp = hasWritableTempBase();

describe("parseSshArgs", () => {
	it("accepts destination plus remote command", () => {
		expect(parseSshArgs(["example.com", "echo", "hello"]))
			.toEqual({
				passthrough: [],
				destination: "example.com",
				remoteArgs: ["echo", "hello"],
			});
	});

	it("accepts a small safe subset of ssh flags", () => {
		expect(parseSshArgs(["-p", "2222", "-o", "BatchMode=yes", "example.com", "pwd"]))
			.toEqual({
				passthrough: ["-p", "2222", "-o", "BatchMode=yes"],
				destination: "example.com",
				remoteArgs: ["pwd"],
			});
	});

	it("rejects custom ssh config files", () => {
		expect(() => parseSshArgs(["-F", "~/.ssh/config", "example.com", "pwd"]))
			.toThrow("unsupported ssh flag: -F");
	});

	it("rejects interactive ssh with no remote command", () => {
		expect(() => parseSshArgs(["example.com"]))
			.toThrow("interactive ssh is disabled; remote command required");
	});

	it("rejects unsupported forwarding flags", () => {
		expect(() => parseSshArgs(["-L", "8080:localhost:80", "example.com", "pwd"]))
			.toThrow("unsupported ssh flag: -L");
	});

	it("rejects unsupported -o options", () => {
		expect(() => parseSshArgs(["-o", "ProxyCommand=nc %h %p", "example.com", "pwd"]))
			.toThrow("unsupported ssh -o option: ProxyCommand=nc %h %p");
	});
});

describe("buildRemoteBwrapCommand", () => {
	it("builds a remote bwrap command with writable paths and network isolation", () => {
		const command = buildRemoteBwrapCommand(["echo", "hello world"], ["/tmp", "/var/data"], { network: false });
		expect(command).toContain("exec bwrap");
		expect(command).toContain("--unshare-net");
		expect(command).toContain("--tmpfs /tmp");
		expect(command).toContain("--bind '/var/data' '/var/data'");
		expect(command).toContain("bash -lc");
	});
});

describe("buildBwrapCommand", () => {
	it("mounts the ssh shim and shim env vars when ssh policy is enabled", () => {
		const command = buildBwrapCommand(
			"ssh example.com echo hello",
			"/repo",
			["/tmp"],
			{ network: true },
			{
				mode: "require-remote-bwrap",
				realSshPath: "/usr/bin/ssh",
				shimPath: "/package/extensions/ssh-shim.js",
				sandboxRealSshPath: "/run/pi-bash-readonly/real-ssh",
			},
		);
		expect(command).toContain("--dir /run/pi-bash-readonly");
		expect(command).toContain("--ro-bind '/usr/bin/ssh' '/run/pi-bash-readonly/real-ssh'");
		expect(command).toContain("--ro-bind '/package/extensions/ssh-shim.js' '/usr/bin/ssh'");
		expect(command).toContain("--setenv PI_BASH_RO_REAL_SSH '/run/pi-bash-readonly/real-ssh'");
		expect(command).toContain("--setenv PI_BASH_RO_SSH_POLICY 'require-remote-bwrap'");
		expect(command).toContain("--setenv PI_BASH_RO_NETWORK '1'");
	});
});

describe.skipIf(!hasWritableTemp)("ssh-shim main", () => {
	it("probes remote bwrap before executing the wrapped remote command", () => {
		const dir = makeTempDir("pi-bash-ro-ssh-shim-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		const result = spawnSync(process.execPath, [join(process.cwd(), "extensions", "ssh-shim.js"), "example.com", "echo", "hello"], {
			cwd: process.cwd(),
			encoding: "utf-8",
			env: {
				...process.env,
				FAKE_SSH_HAS_BWRAP: "1",
				FAKE_SSH_LOG: logPath,
				PI_BASH_RO_NETWORK: "0",
				PI_BASH_RO_REAL_SSH: scriptPath,
				PI_BASH_RO_SSH_POLICY: "require-remote-bwrap",
				PI_BASH_RO_WRITABLE_PATHS: JSON.stringify(["/tmp"]),
			},
		});

		expect(result.status).toBe(0);
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none example.com command -v bwrap >/dev/null 2>&1");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none example.com exec bwrap");
		expect(log).toContain("REMOTE\texec bwrap");
		expect(log).toContain("--unshare-net");
		expect(log).toContain("--tmpfs /tmp");
	});

	it("fails closed when the remote bwrap probe fails", () => {
		const dir = makeTempDir("pi-bash-ro-ssh-shim-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		const result = spawnSync(process.execPath, [join(process.cwd(), "extensions", "ssh-shim.js"), "example.com", "echo", "hello"], {
			cwd: process.cwd(),
			encoding: "utf-8",
			env: {
				...process.env,
				FAKE_SSH_HAS_BWRAP: "0",
				FAKE_SSH_LOG: logPath,
				PI_BASH_RO_NETWORK: "0",
				PI_BASH_RO_REAL_SSH: scriptPath,
				PI_BASH_RO_SSH_POLICY: "require-remote-bwrap",
				PI_BASH_RO_WRITABLE_PATHS: "[]",
			},
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing ssh without confirmed remote bwrap");
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none example.com command -v bwrap >/dev/null 2>&1");
		expect(log).not.toContain("REMOTE\t");
	});

	it("fails closed for interactive ssh", () => {
		const dir = makeTempDir("pi-bash-ro-ssh-shim-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		const result = spawnSync(process.execPath, [join(process.cwd(), "extensions", "ssh-shim.js"), "example.com"], {
			cwd: process.cwd(),
			encoding: "utf-8",
			env: {
				...process.env,
				FAKE_SSH_HAS_BWRAP: "1",
				FAKE_SSH_LOG: logPath,
				PI_BASH_RO_NETWORK: "0",
				PI_BASH_RO_REAL_SSH: scriptPath,
				PI_BASH_RO_SSH_POLICY: "require-remote-bwrap",
				PI_BASH_RO_WRITABLE_PATHS: "[]",
			},
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("interactive ssh is disabled");
		expect(() => readFileSync(logPath, "utf-8")).toThrow();
	});
});
