import { describe, expect, it } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRemoteBashOperations } from "../extensions/index.ts";

const runDockerTests = process.env.PI_BASH_RO_RUN_DOCKER_TESTS === "1";
const dockerSshHost = process.env.PI_BASH_RO_SSH_HOST ?? "127.0.0.1";
const dockerSshUser = process.env.PI_BASH_RO_SSH_USER ?? "pi";
const dockerSshKeyPath = process.env.PI_BASH_RO_SSH_KEY_PATH ?? "";
const withBwrapPort = process.env.PI_BASH_RO_SSH_PORT_WITH_BWRAP ?? "22221";
const withoutBwrapPort = process.env.PI_BASH_RO_SSH_PORT_WITHOUT_BWRAP ?? "22222";
const sshPath = execSync("command -v ssh", { encoding: "utf-8" }).trim();
const nodePath = execSync("command -v node", { encoding: "utf-8" }).trim();
const remoteBwrapLogPath = "/tmp/pi-bash-ro-bwrap.log";

function baseConnectionArgs(port: string): string[] {
	if (!dockerSshKeyPath) {
		throw new Error("missing PI_BASH_RO_SSH_KEY_PATH for docker ssh tests");
	}

	return [
		"-i", dockerSshKeyPath,
		"-l", dockerSshUser,
		"-p", port,
		"-o", "IdentitiesOnly=yes",
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		"-o", "ConnectTimeout=5",
	];
}

function runDirectSsh(port: string, command: string) {
	return spawnSync(sshPath, ["-F", "/dev/null", ...baseConnectionArgs(port), dockerSshHost, command], {
		encoding: "utf-8",
	});
}

function clearRemoteBwrapLog(port: string) {
	const result = runDirectSsh(port, `rm -f ${remoteBwrapLogPath}`);
	expect(result.status).toBe(0);
}

function runSshShim(port: string, remoteArgs: string[]) {
	return spawnSync(nodePath, [join(process.cwd(), "extensions", "ssh-shim.js"), ...baseConnectionArgs(port), dockerSshHost, ...remoteArgs], {
		encoding: "utf-8",
		env: {
			...process.env,
			PI_BASH_RO_NETWORK: "0",
			PI_BASH_RO_REAL_SSH: sshPath,
			PI_BASH_RO_SSH_POLICY: "require-remote-bwrap",
			PI_BASH_RO_WRITABLE_PATHS: JSON.stringify(["/tmp"]),
		},
	});
}

describe.skipIf(!runDockerTests)("docker ssh validation", () => {
	it("allows sandboxed local ssh when the remote host provides bwrap", () => {
		clearRemoteBwrapLog(withBwrapPort);

		const result = runSshShim(withBwrapPort, [
			"bash",
			"-lc",
			`test -f ${remoteBwrapLogPath} && printf local-ssh-ok`,
		]);

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("local-ssh-ok");
	});

	it("blocks sandboxed local ssh when the remote host lacks bwrap", () => {
		const result = runSshShim(withoutBwrapPort, ["echo", "hello"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing ssh without confirmed remote bwrap");
	});

	it("rejects interactive sandboxed local ssh", () => {
		const result = runSshShim(withBwrapPort, []);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("interactive ssh is disabled");
	});

	it("allows configured remote bash in readonly mode when remote bwrap exists", async () => {
		clearRemoteBwrapLog(withBwrapPort);
		const chunks: Buffer[] = [];
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath,
			execution: {
				type: "ssh",
				host: dockerSshHost,
				cwd: "/srv/project",
				args: baseConnectionArgs(withBwrapPort),
			},
			writablePaths: ["/tmp"],
			network: false,
			getReadOnly: () => true,
		});

		const result = await ops.exec("test -f /tmp/pi-bash-ro-bwrap.log && pwd", "/local/project/subdir", {
			onData: (data) => chunks.push(Buffer.from(data)),
			timeout: 10,
		});

		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("/srv/project/subdir");
	});

	it("blocks configured remote bash in readonly mode when remote bwrap is unavailable", async () => {
		const ops = createRemoteBashOperations({
			localCwd: "/local/project",
			sshPath,
			execution: {
				type: "ssh",
				host: dockerSshHost,
				cwd: "/srv/project",
				args: baseConnectionArgs(withoutBwrapPort),
			},
			writablePaths: ["/tmp"],
			network: false,
			getReadOnly: () => true,
		});

		await expect(ops.exec("pwd", "/local/project", {
			onData: () => {},
			timeout: 10,
		})).rejects.toThrow("refusing configured remote bash without confirmed remote bwrap");
	});
});
