import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	ProcessStartProbe,
	SessionEvidenceProbe,
} from "flywheel-v2-engine";

/**
 * Codex R3 HIGH-1: absolute, root-owned probe binary. Never PATH-resolved.
 */
const TRUSTED_PS_BIN = "/bin/ps";

/**
 * Codex R3 HIGH-1: classify the probe result instead of collapsing it to
 * `string | null`. The caller can then refuse to act on `unavailable`, which a
 * nullable answer made impossible to distinguish from a genuinely absent pid.
 */
export function probeProcessStart(pid: number): ProcessStartProbe {
	return probeProcessStartWithBin(pid, TRUSTED_PS_BIN);
}

/**
 * Test-protected seam for the probe's binary.
 *
 * Production has exactly one caller -- probeProcessStart above -- and it always
 * passes the pinned TRUSTED_PS_BIN, which is what closes R3 HIGH-1. This exists
 * so a test can drive the "ps fails only for a pid that exists" branch, which
 * cannot be produced against the real /bin/ps. An absolute path is required so
 * this can never become a PATH lookup by another route.
 */
export function probeProcessStartWithBin(
	pid: number,
	psBin: string,
): ProcessStartProbe {
	if (!isAbsolute(psBin)) {
		return { status: "unavailable", reason: "probe binary must be absolute" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return { status: "unavailable", reason: "pid is not a positive integer" };
	}
	if (
		process.env.NODE_ENV === "test" &&
		process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE
	) {
		try {
			const evidence = JSON.parse(
				process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE,
			) as Record<string, unknown>;
			const value = evidence[String(pid)];
			if (typeof value === "string" && value.length > 0) {
				return { status: "present", startIdentity: value };
			}
			if (value === "absent") return { status: "absent" };
		} catch {
			return {
				status: "unavailable",
				reason: "test process start evidence is malformed",
			};
		}
	}
	// Codex R4 HIGH-2: absence comes from a SYSCALL, never from a ps exit status.
	// `exit 1 + empty stdout` was read as absence, but ps can exit 1 for
	// target-specific reasons while writing the real diagnosis to stderr, which this
	// discards -- so a live lead could be declared dead. kill(pid, 0) answers the
	// one question being asked: ESRCH means no such process, EPERM means it exists
	// and is not ours to signal, and anything else is a probe that cannot answer.
	try {
		process.kill(pid, 0);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ESRCH") return { status: "absent" };
		if (code !== "EPERM") {
			return {
				status: "unavailable",
				reason: `kill(pid,0) failed with ${code ?? "an unknown error"}`,
			};
		}
	}
	let raw: string;
	try {
		// Codex R3 HIGH-1: this MUST NOT resolve `ps` through PATH. The production
		// launchd PATH is
		// /opt/homebrew/...:/usr/local/bin:~/.local/bin:/usr/bin:/bin
		// so user-writable directories precede the system ones, and every runner
		// shares this uid. A shadowed `ps` could report an arbitrary start identity
		// for the prior lead pid (or fail only for that pid while still answering a
		// canary), forging absence and enabling a takeover of a LIVE lead. Pin the
		// root-owned absolute path instead.
		raw = execFileSync(psBin, ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (error) {
		// Codex R4 HIGH-2: the pid demonstrably exists (kill(pid,0) succeeded or gave
		// EPERM), so ANY ps failure here is a probe that could not answer -- never
		// absence. Reading a non-zero exit as death is exactly the fail-open that let
		// a live lead be taken over.
		const failure = error as { status?: number | null };
		return {
			status: "unavailable",
			reason: `${psBin} failed with status ${String(failure.status)} for a pid that exists`,
		};
	}
	return classifyProbeOutput(raw);
}

/**
 * A successful `ps -o lstart= -p <one pid>` prints exactly one start identity.
 * Zero lines or several mean the output is not what this probe is defined over
 * -- a `ps` that ignored `-p` and listed every process, say -- so taking the
 * first line would let one pid's answer stand in for another's. Neither is
 * evidence of anything, so both are `unavailable`.
 */
export function classifyProbeOutput(raw: string): ProcessStartProbe {
	const lines = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length !== 1) {
		return {
			status: "unavailable",
			reason: `${TRUSTED_PS_BIN} returned ${lines.length} start identities`,
		};
	}
	return { status: "present", startIdentity: lines[0] as string };
}

/** Convenience for callers that only need the live identity of their own pid. */
export function readProcessStartIdentity(pid: number): string | null {
	const probed = probeProcessStart(pid);
	return probed.status === "present" ? probed.startIdentity : null;
}

function requireRoot(root: string): void {
	if (!isAbsolute(root))
		throw new TypeError("session proof root must be absolute");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	if ((statSync(root).mode & 0o777) !== 0o700) {
		throw new Error("session proof root must be mode 0700");
	}
}

function proofPath(root: string, sessionId: string): string {
	if (sessionId.length === 0 || sessionId.includes("\0")) {
		throw new TypeError("session id must be non-empty and contain no NUL");
	}
	return join(
		root,
		`${createHash("sha256").update(sessionId).digest("hex")}.json`,
	);
}

export function publishSessionProof(options: {
	root: string;
	sessionId: string;
	pid: number;
	pidStart: string;
}): string {
	requireRoot(options.root);
	const path = proofPath(options.root, options.sessionId);
	writeFileSync(
		path,
		`${JSON.stringify({
			v: 1,
			session_id: options.sessionId,
			pid: options.pid,
			pid_start: options.pidStart,
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	chmodSync(path, 0o600);
	return path;
}

export class FileSessionEvidenceProbe implements SessionEvidenceProbe {
	readonly #root: string;

	constructor(root: string) {
		requireRoot(root);
		this.#root = root;
	}

	processStart(pid: number): ProcessStartProbe {
		return probeProcessStart(pid);
	}

	sessionOwner(sessionId: string): { pid: number; pidStart: string } | null {
		try {
			const path = proofPath(this.#root, sessionId);
			if ((statSync(path).mode & 0o777) !== 0o600) return null;
			const value = JSON.parse(readFileSync(path, "utf8")) as {
				v?: unknown;
				session_id?: unknown;
				pid?: unknown;
				pid_start?: unknown;
			};
			if (
				value.v !== 1 ||
				value.session_id !== sessionId ||
				!Number.isSafeInteger(value.pid) ||
				(value.pid as number) <= 0 ||
				typeof value.pid_start !== "string" ||
				value.pid_start.length === 0
			) {
				return null;
			}
			return {
				pid: value.pid as number,
				pidStart: value.pid_start,
			};
		} catch {
			return null;
		}
	}
}
