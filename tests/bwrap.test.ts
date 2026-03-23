import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Skip all tests if bwrap is not available
let hasBwrap = true;
try {
	execSync("which bwrap", { stdio: "ignore" });
} catch {
	hasBwrap = false;
}

function bwrapExec(command: string, writablePaths: string[] = []): { stdout: string; exitCode: number } {
	const tmpFile = join(tmpdir(), `pi-bash-ro-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(tmpFile, command, { mode: 0o700 });

	const parts = [
		"bwrap",
		"--die-with-parent",
		"--ro-bind / /",
		"--dev /dev",
		"--proc /proc",
	];

	for (const p of writablePaths) {
		if (p === "/tmp") {
			parts.push("--tmpfs /tmp");
		} else {
			parts.push(`--bind '${p}' '${p}'`);
		}
	}

	// Script mount must come after --tmpfs /tmp
	parts.push(`--ro-bind ${tmpFile} ${tmpFile}`);
	parts.push(`--chdir ${process.cwd()}`);
	parts.push(`bash ${tmpFile}`);

	const bwrapCmd = `${parts.join(" ")}; __exit=$?; rm -f ${tmpFile}; exit $__exit`;

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

	it("script file is accessible when /tmp is writable", () => {
		// This tests the mount ordering fix — --tmpfs /tmp before --ro-bind script
		const result = bwrapExec("echo mount-order-ok", ["/tmp"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("mount-order-ok");
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
});
