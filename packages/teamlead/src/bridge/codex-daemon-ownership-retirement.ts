/** FLY-2920: retire one immutable daemon ownership claim, never session.json. */
import { createHash, randomUUID } from "node:crypto";
import {
	linkSync,
	lstatSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
	codexAgentHomeDir,
	codexHomeDir,
	codexHomesRoot,
	resolveDaemonSocketPath,
	resolveExecutionCodexHome,
} from "flywheel-claude-runner";
import type {
	CodexDaemonLedger,
	CodexProcessProbeResult,
	SocketHolderProbeResult,
} from "./codex-runner-orphan-reaper.js";

export interface DaemonOwnershipClaim {
	fingerprint: string;
	sessionHash: string;
	sessionPath: string;
	codexAgentHome: unknown;
}
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
	if (value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function readDaemonOwnershipClaim(
	sessionPath: string,
	bytes: string,
	state: Record<string, unknown>,
): DaemonOwnershipClaim {
	const generation = state.daemonOwnershipGeneration;
	if (
		generation !== undefined &&
		(typeof generation !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				generation,
			))
	)
		throw new Error("invalid daemon ownership generation");
	const identity =
		generation === undefined
			? [
					"legacy",
					state.executionId,
					state.daemonPgid,
					digest(canonical(state.codexAgentHome)),
				]
			: ["generation", state.executionId, state.daemonPgid, generation];
	return {
		fingerprint: digest(JSON.stringify(identity)),
		sessionHash: digest(bytes),
		sessionPath,
		codexAgentHome: state.codexAgentHome,
	};
}
function receiptPath(claim: DaemonOwnershipClaim): string {
	return join(
		dirname(claim.sessionPath),
		`daemon-ownership-retired-${claim.fingerprint}.json`,
	);
}
function regularJson(path: string): Record<string, unknown> {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("unsafe ownership file");
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
export function isDaemonOwnershipRetired(claim: DaemonOwnershipClaim): boolean {
	try {
		const receipt = regularJson(receiptPath(claim));
		return receipt.version === 1 && receipt.fingerprint === claim.fingerprint;
	} catch {
		return false;
	}
}
/** Hard-link publish is atomic and exclusive: incomplete temp bytes never suppress a candidate. */
function publishOnce(path: string, value: Record<string, unknown>): boolean {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		try {
			linkSync(temp, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			/* Never remove a peer's receipt. */
		}
	}
}
function unchanged(claim: DaemonOwnershipClaim): boolean {
	try {
		const stat = lstatSync(claim.sessionPath);
		return (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			digest(readFileSync(claim.sessionPath, "utf8")) === claim.sessionHash
		);
	} catch {
		return false;
	}
}
function homeEvidence(
	ledger: CodexDaemonLedger,
	env: NodeJS.ProcessEnv,
): { kind: "missing" | "present"; home: string; inode?: string } | null {
	const claim = ledger.ownership;
	if (!claim) return null;
	let home: string;
	try {
		if (claim.codexAgentHome === undefined)
			home = codexHomeDir(ledger.executionId, env);
		else {
			const record = claim.codexAgentHome as Record<string, unknown>;
			if (
				!record ||
				typeof record !== "object" ||
				typeof record.project !== "string" ||
				typeof record.role !== "string"
			)
				return null;
			home = codexAgentHomeDir(
				{ project: record.project, role: record.role },
				env,
			);
			if (record.home !== home) return null;
		}
		const root = codexHomesRoot(env);
		const suffix = relative(root, home);
		if (!suffix || suffix.startsWith("..") || suffix.startsWith(sep))
			return null;
		// A missing leaf behind a symlink is not an ENOENT ownership proof.
		let path = root;
		for (const part of ["", ...suffix.split(sep)]) {
			if (part) path = join(path, part);
			try {
				const stat = lstatSync(path);
				if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			}
		}
		try {
			const stat = lstatSync(home);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
			const resolution = resolveExecutionCodexHome(
				ledger.executionId,
				undefined,
				env,
			);
			if (resolution.kind === "unknown" || resolution.home !== home)
				return null;
			return { kind: "present", home, inode: `${stat.dev}:${stat.ino}` };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? { kind: "missing", home }
				: null;
		}
	} catch {
		return null;
	}
}
export async function retireDaemonOwnership(
	ledger: CodexDaemonLedger,
	deps: {
		env: NodeJS.ProcessEnv;
		isExecutionActive: (executionId: string) => boolean;
		listProcesses: () => Promise<CodexProcessProbeResult>;
		socketHolderPids: (socket: string) => Promise<SocketHolderProbeResult>;
		audit: (event: string, detail: Record<string, unknown>) => void;
	},
): Promise<boolean> {
	const claim = ledger.ownership;
	if (!claim) return false;
	try {
		if (!unchanged(claim) || deps.isExecutionActive(ledger.executionId))
			return false;
		const initialHome = homeEvidence(ledger, deps.env);
		if (!initialHome) return false;
		const socket = resolveDaemonSocketPath(ledger.executionId, deps.env);
		const probe = async () => {
			const processes = await deps.listProcesses();
			const holders = await deps.socketHolderPids(socket);
			if (
				processes.status !== "ok" ||
				holders.status !== "ok" ||
				holders.pids.length > 0
			)
				return false;
			// daemonPgid is the spawned leader PID. A surviving leader blocks
			// absence even if it moved groups or changed argv. UUIDs fence ledger
			// generations, not process identity; PID reuse conservatively refuses.
			if (
				processes.rows.some(
					(row) =>
						row.pid === ledger.daemonPgid ||
						row.command.includes(socket) ||
						row.command.includes(initialHome.home),
				)
			)
				return false;
			return (
				initialHome.kind === "missing" ||
				!processes.rows.some((row) => row.pgid === ledger.daemonPgid)
			);
		};
		if (!(await probe())) return false;
		if (!(await probe())) return false;
		const finalHome = homeEvidence(ledger, deps.env);
		// All asynchronous probes finish before the final synchronous commit fences.
		if (
			canonical(finalHome) !== canonical(initialHome) ||
			deps.isExecutionActive(ledger.executionId) ||
			!unchanged(claim)
		)
			return false;
		const detail = {
			version: 1,
			fingerprint: claim.fingerprint,
			executionId: ledger.executionId,
			daemonPgid: ledger.daemonPgid,
			reason:
				initialHome.kind === "missing" ? "home_enoent" : "ownership_absent",
			home: initialHome.home,
			sessionHash: claim.sessionHash,
		};
		if (publishOnce(receiptPath(claim), detail))
			deps.audit("codex_daemon_ownership_retired", detail);
		return isDaemonOwnershipRetired(claim);
	} catch {
		return false;
	}
}

/** Durable audit dedupe is scoped to identity + reason + stable ownership evidence. */
export function auditDaemonOwnershipMismatch(
	ledger: CodexDaemonLedger,
	detail: Record<string, unknown>,
	evidence: unknown,
	audit: (event: string, detail: Record<string, unknown>) => void,
): void {
	const claim = ledger.ownership;
	if (!claim) {
		audit("codex_app_server_orphan_identity_mismatch", detail);
		return;
	}
	const reason = "identity_mismatch";
	const evidenceDigest = digest(canonical(evidence));
	const value = {
		...detail,
		fingerprint: claim.fingerprint,
		reason,
		evidenceDigest,
	};
	try {
		if (!unchanged(claim)) return;
		const path = join(
			dirname(claim.sessionPath),
			`daemon-ownership-audit-${claim.fingerprint}-${reason}-${evidenceDigest}.json`,
		);
		if (publishOnce(path, value))
			audit("codex_app_server_orphan_identity_mismatch", value);
	} catch {
		/* Unknown persistence cannot authorize retirement or a signal. */
	}
}
