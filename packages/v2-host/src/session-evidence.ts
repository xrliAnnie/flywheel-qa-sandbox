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
import type { SessionEvidenceProbe } from "flywheel-v2-engine";

export function readProcessStartIdentity(pid: number): string | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	if (
		process.env.NODE_ENV === "test" &&
		process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE
	) {
		try {
			const evidence = JSON.parse(
				process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE,
			) as Record<string, unknown>;
			const value = evidence[String(pid)];
			if (typeof value === "string" && value.length > 0) return value;
		} catch {
			return null;
		}
	}
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
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

	processStart(pid: number): string | null {
		return readProcessStartIdentity(pid);
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
