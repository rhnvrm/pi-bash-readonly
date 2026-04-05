import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Skip all tests if bwrap is not available
let hasBwrap = true;
try {
	execSync("which bwrap", { stdio: "ignore" });
} catch {
	hasBwrap = false;
}

/** Shell-escape a string by wrapping in single quotes. */
function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build and execute a bwrap command using bash -c (no temp files).
 * This mirrors the production buildBwrapCommand approach.
 */
function bwrapExec(command: string, writablePaths: string[] = [], options?: { network?: boolean }): { stdout: string; exitCode: number } {
	const parts = [
		"bwrap",
		"--die-with-parent",
		"--ro-bind / /",
		"--dev /dev",
		"--proc /proc",
	];

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

	parts.push(`--chdir ${shellEscape(process.cwd())}`);
	parts.push(`bash -c ${shellEscape(command)}`);

	const bwrapCmd = parts.join(" ");

	try {
		const stdout = execSync(bwrapCmd, { encoding: "utf-8", timeout: 5000 });
		return { stdout: stdout.trim(), exitCode: 0 };
	} catch (err: any) {
		return { stdout: (err.stdout || "").trim(), exitCode: err.status ?? 1 };
	}
}

describe.skipIf(!hasBwrap)("bwrap sandbox", () => {
	it("allows reading files", () => {
		const result = bwrapExec("cat /proc/version");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Linux");
	});

	it("blocks writing to filesystem", () => {
		const target = join(tmpdir(), `pi-bash-ro-write-test-${Date.now()}`);
		const result = bwrapExec(`echo "should fail" > ${target}`);
		expect(result.exitCode).not.toBe(0);
		expect(existsSync(target)).toBe(false);
	});

	it("blocks writing to home directory", () => {
		const result = bwrapExec("touch ~/pi-bash-ro-test-file");
		expect(result.exitCode).not.toBe(0);
	});

	it("blocks mkdir", () => {
		const result = bwrapExec("mkdir /pi-bash-ro-test-dir");
		expect(result.exitCode).not.toBe(0);
	});

	it("allows writing to /tmp when configured", () => {
		const result = bwrapExec(
			'echo "hello" > /tmp/test-file && cat /tmp/test-file',
			["/tmp"],
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello");
	});

	it("allows writing only to configured writable paths", () => {
		const writableDir = mkdtempSync(join(tmpdir(), "pi-bash-ro-writable-"));
		const result = bwrapExec(
			`echo "allowed" > ${writableDir}/test.txt && cat ${writableDir}/test.txt`,
			[writableDir],
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("allowed");
	});

	it("still blocks writes outside configured writable paths", () => {
		const writableDir = mkdtempSync(join(tmpdir(), "pi-bash-ro-writable-"));
		const result = bwrapExec(
			`echo "should fail" > /home/pi-bash-ro-test 2>&1`,
			[writableDir],
		);
		expect(result.exitCode).not.toBe(0);
	});

	it("preserves working directory", () => {
		const result = bwrapExec("pwd");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(process.cwd());
	});

	it("has /dev/null available", () => {
		const result = bwrapExec("echo test > /dev/null && echo ok");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ok");
	});

	it("has /proc available", () => {
		const result = bwrapExec("echo $$");
		expect(result.exitCode).toBe(0);
		expect(Number(result.stdout)).toBeGreaterThan(0);
	});

	it("preserves exit code from command", () => {
		const result = bwrapExec("exit 42");
		expect(result.exitCode).toBe(42);
	});

	it("handles commands with single quotes", () => {
		const result = bwrapExec("echo 'hello world'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello world");
	});

	it("handles commands with double quotes and variables", () => {
		const result = bwrapExec('FOO=bar && echo "value is $FOO"');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("value is bar");
	});

	it("handles multi-line commands", () => {
		const result = bwrapExec("echo line1\necho line2");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("line1\nline2");
	});
});

describe.skipIf(!hasBwrap)("bwrap network isolation", () => {
	it("blocks network access by default", () => {
		// TCP connections should fail in the unshared network namespace
		const result = bwrapExec("bash -c 'echo > /dev/tcp/1.1.1.1/80' 2>&1", [], { network: false });
		expect(result.exitCode).not.toBe(0);
	});

	it("has only loopback when isolated vs host interfaces when not", () => {
		// ip link works with /proc, no /sys needed
		const isolated = bwrapExec("cat /proc/net/dev | tail -n +3 | awk -F: '{print $1}' | tr -d ' '", [], { network: false });
		const shared = bwrapExec("cat /proc/net/dev | tail -n +3 | awk -F: '{print $1}' | tr -d ' '", [], { network: true });
		expect(isolated.exitCode).toBe(0);
		expect(shared.exitCode).toBe(0);
		// Isolated namespace should have only lo; shared should have host interfaces too
		const isolatedIfaces = isolated.stdout.trim().split("\n").filter(Boolean);
		const sharedIfaces = shared.stdout.trim().split("\n").filter(Boolean);
		expect(isolatedIfaces).toEqual(["lo"]);
		expect(sharedIfaces.length).toBeGreaterThan(isolatedIfaces.length);
	});

	it("still allows reading files with network isolated", () => {
		const result = bwrapExec("cat /proc/version", [], { network: false });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Linux");
	});
});
