import { accessSync, constants, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function getTempCandidates(): string[] {
	return [
		process.env.PI_BASH_RO_TEST_TMPDIR,
		process.env.BOSUN_WORKSPACE
			? join(process.env.BOSUN_WORKSPACE, "scratch", "pi-bash-readonly-tests")
			: undefined,
		process.env.TMPDIR,
		process.env.TEMP,
		process.env.TMP,
		tmpdir(),
	].filter((value): value is string => Boolean(value));
}

export function findWritableTempBase(): string | undefined {
	for (const candidate of getTempCandidates()) {
		try {
			mkdirSync(candidate, { recursive: true });
			accessSync(candidate, constants.W_OK);
			return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

export function hasWritableTempBase(): boolean {
	return findWritableTempBase() !== undefined;
}

export function cleanupWritableTempBase(): void {
	// No shared temp base to clean up.
}

export function getWritableTempBase(): string {
	const base = findWritableTempBase();
	if (!base) {
		throw new Error("No writable temp directory available for tests");
	}
	return base;
}

export function createWritableTempDir(prefix: string): string {
	return mkdtempSync(join(getWritableTempBase(), prefix));
}
