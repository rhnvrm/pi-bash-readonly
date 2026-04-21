#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SSH_FLAGS_WITH_VALUE = new Set(["-i", "-l", "-o", "-p"]);
const SSH_FLAGS_NO_VALUE = new Set(["-4", "-6", "-A", "-a", "-C", "-q", "-T", "-v", "-vv", "-vvv"]);
const SSH_FLAGS_REJECTED = new Set(["-D", "-F", "-f", "-G", "-J", "-L", "-M", "-N", "-O", "-R", "-S", "-s", "-W", "-w"]);
const STERILE_SSH_ARGS = Object.freeze([
	"-F", "/dev/null",
	"-T",
	"-o", "BatchMode=yes",
	"-o", "ClearAllForwardings=yes",
	"-o", "PermitLocalCommand=no",
	"-o", "ProxyCommand=none",
]);
const SSH_O_OPTION_WHITELIST = new Set([
	"BatchMode",
	"ConnectTimeout",
	"IdentityFile",
	"IdentitiesOnly",
	"LogLevel",
	"Port",
	"StrictHostKeyChecking",
	"User",
	"UserKnownHostsFile",
]);

function shellEscape(value) {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function fail(message) {
	console.error(`[pi-bash-readonly] ${message}`);
	process.exit(1);
}

function getSshOptionKey(value) {
	const [key] = String(value).split("=", 1);
	return key;
}

function isAllowedSshOption(value) {
	return SSH_O_OPTION_WHITELIST.has(getSshOptionKey(value));
}

export function parseSshArgs(argv) {
	const passthrough = [];
	let index = 0;

	while (index < argv.length) {
		const arg = argv[index];
		if (arg === "--") {
			throw new Error("ssh '--' passthrough is not supported in read-only mode");
		}
		if (SSH_FLAGS_REJECTED.has(arg)) {
			throw new Error(`unsupported ssh flag: ${arg}`);
		}
		if (SSH_FLAGS_NO_VALUE.has(arg)) {
			passthrough.push(arg);
			index += 1;
			continue;
		}
		if (SSH_FLAGS_WITH_VALUE.has(arg)) {
			const value = argv[index + 1];
			if (value === undefined) {
				throw new Error(`ssh flag requires a value: ${arg}`);
			}
			if (arg === "-o" && !isAllowedSshOption(value)) {
				throw new Error(`unsupported ssh -o option: ${value}`);
			}
			passthrough.push(arg, value);
			index += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`unsupported ssh flag: ${arg}`);
		}
		break;
	}

	const destination = argv[index];
	if (!destination) {
		throw new Error("missing ssh destination");
	}

	const remoteArgs = argv.slice(index + 1);
	if (remoteArgs.length === 0) {
		throw new Error("interactive ssh is disabled; remote command required");
	}

	return { passthrough, destination, remoteArgs };
}

function parseWritablePaths() {
	const raw = process.env.PI_BASH_RO_WRITABLE_PATHS;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

export function buildRemoteBwrapCommand(remoteArgs, writablePaths = [], options = {}) {
	const originalRemoteCommand = remoteArgs.map((arg) => shellEscape(String(arg))).join(" ");
	const parts = [
		"exec bwrap",
		"--die-with-parent",
		"--ro-bind / /",
		"--dev /dev",
		"--proc /proc",
	];

	if (!options.network) {
		parts.push("--unshare-net");
	}

	for (const writablePath of writablePaths) {
		if (writablePath === "/tmp") {
			parts.push("--tmpfs /tmp");
		} else {
			parts.push(`--bind ${shellEscape(writablePath)} ${shellEscape(writablePath)}`);
		}
	}

	parts.push(`bash -lc ${shellEscape(originalRemoteCommand)}`);
	return parts.join(" ");
}

function buildSterileSshArgs(args = []) {
	return [...STERILE_SSH_ARGS, ...args];
}

function runSsh(realSshPath, args) {
	const result = spawnSync(realSshPath, args, { stdio: "inherit" });
	if (result.error) {
		throw result.error;
	}
	if (result.signal) {
		process.kill(process.pid, result.signal);
	}
	process.exit(result.status ?? 1);
}

export function main(argv = process.argv.slice(2)) {
	const realSshPath = process.env.PI_BASH_RO_REAL_SSH;
	if (!realSshPath) {
		fail("missing PI_BASH_RO_REAL_SSH for ssh sandbox shim");
	}

	const sshPolicy = process.env.PI_BASH_RO_SSH_POLICY ?? "off";
	if (sshPolicy === "off") {
		runSsh(realSshPath, argv);
		return;
	}

	if (sshPolicy !== "require-remote-bwrap") {
		fail(`unsupported ssh policy mode: ${sshPolicy}`);
	}

	let parsed;
	try {
		parsed = parseSshArgs(argv);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	const writablePaths = parseWritablePaths();
	const network = process.env.PI_BASH_RO_NETWORK === "1";
	const probeArgs = buildSterileSshArgs([...parsed.passthrough, parsed.destination, "command -v bwrap >/dev/null 2>&1"]);
	const probe = spawnSync(realSshPath, probeArgs, { stdio: "inherit" });
	if (probe.error) {
		fail(`remote bwrap probe failed: ${probe.error.message}`);
	}
	if (probe.status !== 0) {
		fail(`remote bwrap probe failed for ${parsed.destination}; refusing ssh without confirmed remote bwrap`);
	}

	const remoteCommand = buildRemoteBwrapCommand(parsed.remoteArgs, writablePaths, { network });
	runSsh(realSshPath, buildSterileSshArgs([...parsed.passthrough, parsed.destination, remoteCommand]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
