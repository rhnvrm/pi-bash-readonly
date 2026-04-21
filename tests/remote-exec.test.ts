import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRemoteExecutionCommand,
	buildSterileSshArgs,
	createRemoteBashOperations,
	mapLocalToRemoteCwd,
	sanitizeConfiguredSshArgs,
	validateConfiguredSshHost,
} from "../extensions/index.ts";
import { createWritableTempDir, hasWritableTempBase } from "./temp-dir.js";

const createdDirs: string[] = [];
const hasWritableTemp = hasWritableTempBase();

function makeTempDir(prefix: string): string {
	const dir = createWritableTempDir(prefix);
	createdDirs.push(dir);
	return dir;
}

function createFakeSshScript(dir: string): { scriptPath: string; logPath: string } {
	const logPath = join(dir, "fake-remote-ssh.log");
	const scriptPath = join(dir, "fake-remote-ssh.sh");
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env bash
set -euo pipefail
log_file="\${FAKE_SSH_LOG:?}"
printf 'CALL\t%s\n' "$*" >> "$log_file"
last="\${!#}"
if [[ -n "\${FAKE_SSH_DELAY_SECONDS:-}" ]]; then
  sleep "\${FAKE_SSH_DELAY_SECONDS}"
fi
if [[ "$last" == "pwd" ]]; then
  printf '%s\n' "\${FAKE_REMOTE_PWD:-/remote/project}"
  exit 0
fi
if [[ "$last" == "command -v bwrap >/dev/null 2>&1" ]]; then
  if [[ "\${FAKE_SSH_HAS_BWRAP:-0}" == "1" ]]; then
    exit 0
  fi
  echo "missing bwrap" >&2
  exit 1
fi
printf 'REMOTE\t%s\n' "$last" >> "$log_file"
if [[ -n "\${FAKE_SSH_STDOUT:-}" ]]; then
  printf '%s' "\${FAKE_SSH_STDOUT}"
fi
exit "\${FAKE_SSH_EXIT:-0}"
`,
	);
	chmodSync(scriptPath, 0o755);
	return { scriptPath, logPath };
}

afterEach(() => {
	delete process.env.FAKE_REMOTE_PWD;
	delete process.env.FAKE_SSH_EXIT;
	delete process.env.FAKE_SSH_DELAY_SECONDS;
	delete process.env.FAKE_SSH_HAS_BWRAP;
	delete process.env.FAKE_SSH_LOG;
	delete process.env.FAKE_SSH_STDOUT;
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("sanitizeConfiguredSshArgs", () => {
	it("accepts a small safe subset of configured ssh flags", () => {
		expect(sanitizeConfiguredSshArgs(["-p", "2222", "-o", "BatchMode=yes"]))
			.toEqual(["-p", "2222", "-o", "BatchMode=yes"]);
	});

	it("rejects custom ssh config files", () => {
		expect(() => sanitizeConfiguredSshArgs(["-F", "~/.ssh/config"]))
			.toThrow("unsupported configured ssh arg: -F");
	});

	it("rejects unsafe -o options", () => {
		expect(() => sanitizeConfiguredSshArgs(["-o", "ProxyCommand=nc %h %p"]))
			.toThrow("unsupported configured ssh -o option: ProxyCommand=nc %h %p");
	});
});

describe("validateConfiguredSshHost", () => {
	it("accepts a normal SSH destination", () => {
		expect(validateConfiguredSshHost("user@example.com")).toBe("user@example.com");
	});

	it("rejects option-like destinations", () => {
		expect(() => validateConfiguredSshHost("-oProxyCommand=evil")).toThrow("execution.host must not start with '-'");
	});

	it("rejects empty destinations", () => {
		expect(() => validateConfiguredSshHost("   ")).toThrow("requires a non-empty execution.host");
	});
});

describe("buildSterileSshArgs", () => {
	it("prepends sterile ssh args before configured ssh args", () => {
		const args = buildSterileSshArgs(["-p", "2222"]);
		expect(args.slice(0, 11)).toEqual([
			"-F", "/dev/null",
			"-T",
			"-o", "BatchMode=yes",
			"-o", "ClearAllForwardings=yes",
			"-o", "PermitLocalCommand=no",
			"-o", "ProxyCommand=none",
		]);
		expect(args.slice(-2)).toEqual(["-p", "2222"]);
	});
});

describe("mapLocalToRemoteCwd", () => {
	it("maps a local subdirectory onto the configured remote root", () => {
		expect(mapLocalToRemoteCwd("/local/project", "/local/project/src/lib", "/remote/project"))
			.toBe("/remote/project/src/lib");
	});

	it("falls back to the remote root when exec cwd is outside the local root", () => {
		expect(mapLocalToRemoteCwd("/local/project", "/elsewhere", "/remote/project"))
			.toBe("/remote/project");
	});
});

describe("buildRemoteExecutionCommand", () => {
	it("builds a direct remote command when read-only mode is off", () => {
		expect(buildRemoteExecutionCommand("echo hello", "/remote/project", false, [], { network: true }))
			.toBe("cd '/remote/project' && echo hello");
	});

	it("wraps the remote command in remote bwrap when read-only mode is on", () => {
		const command = buildRemoteExecutionCommand("echo hello", "/remote/project", true, ["/tmp"], { network: false });
		expect(command).toContain("exec bwrap");
		expect(command).toContain("--unshare-net");
		expect(command).toContain("--tmpfs /tmp");
		expect(command).toContain("/remote/project");
		expect(command).toContain("echo hello");
	});
});

describe.skipIf(!hasWritableTemp)("createRemoteBashOperations", () => {
	it("probes remote bwrap and runs sandboxed commands remotely in read-only mode", async () => {
		const dir = makeTempDir("pi-bash-ro-remote-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		process.env.FAKE_SSH_HAS_BWRAP = "1";
		process.env.FAKE_SSH_LOG = logPath;
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: scriptPath,
			execution: {
				type: "ssh",
				host: "example.com",
				cwd: "/remote/project",
				args: ["-p", "2222"],
			},
			writablePaths: ["/tmp"],
			network: false,
			getReadOnly: () => true,
		});

		const result = await ops.exec("echo hello", "/local/project/subdir", {
			onData: () => {},
			timeout: 5,
		});

		expect(result.exitCode).toBe(0);
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none -p 2222 example.com command -v bwrap >/dev/null 2>&1");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none -p 2222 example.com exec bwrap");
		expect(log).toContain("REMOTE\texec bwrap");
		expect(log).toContain("/remote/project/subdir");
		expect(log).toContain("echo hello");
	});

	it("runs direct remote commands without probing bwrap when read-only mode is off", async () => {
		const dir = makeTempDir("pi-bash-ro-remote-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		process.env.FAKE_SSH_LOG = logPath;
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: scriptPath,
			execution: {
				type: "ssh",
				host: "example.com",
				cwd: "/remote/project",
				args: [],
			},
			writablePaths: [],
			network: true,
			getReadOnly: () => false,
		});

		const result = await ops.exec("pwd", "/local/project/subdir", {
			onData: () => {},
			timeout: 5,
		});

		expect(result.exitCode).toBe(0);
		const log = readFileSync(logPath, "utf-8");
		expect(log).not.toContain("command -v bwrap >/dev/null 2>&1");
		expect(log).toContain("REMOTE\tcd '/remote/project/subdir' && pwd");
	});

	it("resolves the remote cwd lazily with pwd when config omits execution.cwd", async () => {
		const dir = makeTempDir("pi-bash-ro-remote-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		process.env.FAKE_REMOTE_PWD = "/remote/project";
		process.env.FAKE_SSH_LOG = logPath;
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: scriptPath,
			execution: {
				type: "ssh",
				host: "example.com",
				args: [],
			},
			writablePaths: [],
			network: true,
			getReadOnly: () => false,
		});

		const result = await ops.exec("pwd", "/local/project/src", {
			onData: () => {},
			timeout: 5,
		});

		expect(result.exitCode).toBe(0);
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none example.com pwd");
		expect(log).toContain("REMOTE\tcd '/remote/project/src' && pwd");
	});

	it("fails closed when remote bwrap is unavailable in read-only mode", async () => {
		const dir = makeTempDir("pi-bash-ro-remote-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		process.env.FAKE_SSH_HAS_BWRAP = "0";
		process.env.FAKE_SSH_LOG = logPath;
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: scriptPath,
			execution: {
				type: "ssh",
				host: "example.com",
				cwd: "/remote/project",
				args: [],
			},
			writablePaths: [],
			network: false,
			getReadOnly: () => true,
		});

		await expect(ops.exec("echo hello", "/local/project", {
			onData: () => {},
			timeout: 5,
		})).rejects.toThrow("refusing configured remote bash without confirmed remote bwrap");

		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("CALL\t-F /dev/null -T -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none example.com command -v bwrap >/dev/null 2>&1");
		expect(log).not.toContain("REMOTE\t");
	});

	it("rejects invalid configured SSH destinations before spawning ssh", () => {
		expect(() => createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: "/usr/bin/ssh",
			execution: {
				type: "ssh",
				host: "-oProxyCommand=evil",
				cwd: "/remote/project",
				args: [],
			},
			writablePaths: [],
			network: false,
			getReadOnly: () => true,
		})).toThrow("execution.host must not start with '-'");
	});

	it("applies per-call timeout while resolving remote cwd", async () => {
		const dir = makeTempDir("pi-bash-ro-remote-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		process.env.FAKE_SSH_DELAY_SECONDS = "1";
		process.env.FAKE_SSH_LOG = logPath;
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: scriptPath,
			execution: {
				type: "ssh",
				host: "example.com",
				args: [],
			},
			writablePaths: [],
			network: true,
			getReadOnly: () => false,
		});

		await expect(ops.exec("pwd", "/local/project", {
			onData: () => {},
			timeout: 0.05,
		})).rejects.toThrow("timeout:0.05");
		expect(readFileSync(logPath, "utf-8")).toContain(" example.com pwd");
	});

	it("applies per-call timeout while probing remote bwrap", async () => {
		const dir = makeTempDir("pi-bash-ro-remote-");
		const { scriptPath, logPath } = createFakeSshScript(dir);
		process.env.FAKE_SSH_DELAY_SECONDS = "1";
		process.env.FAKE_SSH_HAS_BWRAP = "1";
		process.env.FAKE_SSH_LOG = logPath;
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath: scriptPath,
			execution: {
				type: "ssh",
				host: "example.com",
				cwd: "/remote/project",
				args: [],
			},
			writablePaths: [],
			network: false,
			getReadOnly: () => true,
		});

		await expect(ops.exec("echo hello", "/local/project", {
			onData: () => {},
			timeout: 0.05,
		})).rejects.toThrow("timeout:0.05");
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("command -v bwrap >/dev/null 2>&1");
		expect(log).not.toContain("REMOTE\t");
	});
});
