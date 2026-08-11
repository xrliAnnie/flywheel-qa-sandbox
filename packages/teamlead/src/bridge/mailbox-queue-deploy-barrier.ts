/**
 * FLY-1573 — deployment-owned readiness barrier for the default-ON mailbox queue.
 *
 * A Flywheel deploy starts the new Bridge before replacing every Lead. The new
 * queue protocol therefore must remain OFF until all Lead launchers and ACK MCP
 * tools are proven ready. This marker and FLYWHEEL_MAILBOX_QUEUE are always
 * changed under the canonical `<env>.lock`; the marker is written first so a
 * process death at any seam is restart-safe.
 *
 * The marker is ownership, not merely status. An operator OFF invalidates its
 * token even when `FLYWHEEL_MAILBOX_QUEUE=0` is already a byte-for-byte no-op,
 * preventing a resumed deploy from undoing an emergency rollback.
 */

import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	applyEnvChange,
	computeEnvSha,
	readEnvValue,
	withEnvFileLock,
	writeEnvFileAtomic,
} from "./env-file-writer.js";

export const MAILBOX_QUEUE_ENV_VAR = "FLYWHEEL_MAILBOX_QUEUE";

export type MailboxQueueDeployBarrierPhase =
	| "preparing"
	| "off_persisted"
	| "ready"
	| "releasing"
	| "released"
	| "failed"
	| "operator_override";

export interface MailboxQueueDeployBarrierMarker {
	schemaVersion: 1;
	targetSha: string;
	priorRaw: string | null;
	phase: MailboxQueueDeployBarrierPhase;
	ownershipToken: string;
	/** SHA-256 of the env bytes expected for this phase. */
	envRevision: string;
	updatedAt: string;
	reason?: string;
	readinessEvidence?: string;
}

export interface MailboxQueueDeployBarrierDeps {
	envPath: string;
	markerPath?: string;
	env?: Record<string, string | undefined>;
	newToken?: () => string;
	now?: () => string;
	lock?: <T>(fn: () => T) => T;
}

export interface MailboxQueueDeployBarrierResult {
	ok: boolean;
	code: 0 | 400 | 409 | 500;
	reason?: string;
	owned?: boolean;
	operatorOff?: boolean;
	alreadyReleased?: boolean;
	released?: boolean;
	token?: string;
	phase?: MailboxQueueDeployBarrierPhase;
	ownershipInvalidated?: boolean;
}

function nowIso(deps: MailboxQueueDeployBarrierDeps): string {
	return deps.now?.() ?? new Date().toISOString();
}

function newOwnershipToken(deps: MailboxQueueDeployBarrierDeps): string {
	return deps.newToken?.() ?? randomBytes(24).toString("base64url");
}

export function defaultMailboxQueueBarrierMarkerPath(envPath: string): string {
	return join(dirname(envPath), "state", "mailbox-queue-deploy-barrier.json");
}

function markerPath(deps: MailboxQueueDeployBarrierDeps): string {
	return deps.markerPath ?? defaultMailboxQueueBarrierMarkerPath(deps.envPath);
}

function readEnvContent(envPath: string): string {
	return readFileSync(envPath, "utf8");
}

function rawFromContent(content: string): string | null {
	return readEnvValue(content, MAILBOX_QUEUE_ENV_VAR) ?? null;
}

function writeMarkerAtomic(
	path: string,
	marker: MailboxQueueDeployBarrierMarker,
): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(
		dir,
		`.mailbox-queue-barrier.${process.pid}.${Date.now()}.tmp`,
	);
	writeFileSync(tmp, `${JSON.stringify(marker)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	renameSync(tmp, path);
}

function isMarker(value: unknown): value is MailboxQueueDeployBarrierMarker {
	if (!value || typeof value !== "object") return false;
	const m = value as Record<string, unknown>;
	return (
		m.schemaVersion === 1 &&
		typeof m.targetSha === "string" &&
		(m.priorRaw === null || typeof m.priorRaw === "string") &&
		typeof m.phase === "string" &&
		[
			"preparing",
			"off_persisted",
			"ready",
			"releasing",
			"released",
			"failed",
			"operator_override",
		].includes(m.phase) &&
		typeof m.ownershipToken === "string" &&
		typeof m.envRevision === "string" &&
		typeof m.updatedAt === "string"
	);
}

export function readMailboxQueueDeployBarrierMarker(
	path: string,
): MailboxQueueDeployBarrierMarker | undefined {
	if (!existsSync(path)) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isMarker(parsed))
		throw new Error(`invalid mailbox queue barrier: ${path}`);
	return parsed;
}

function underLock<T>(deps: MailboxQueueDeployBarrierDeps, fn: () => T): T {
	return (deps.lock ?? ((body) => withEnvFileLock(deps.envPath, body)))(fn);
}

function validateTargetSha(
	targetSha: string,
): MailboxQueueDeployBarrierResult | undefined {
	if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
		return { ok: false, code: 400, reason: "target SHA must be 40 hex chars" };
	}
	return undefined;
}

function applyEnvRaw(content: string, raw: string | null): string {
	const result = applyEnvChange(content, MAILBOX_QUEUE_ENV_VAR, raw);
	if (!result.ok || result.next === undefined) {
		throw new Error(result.reason ?? "cannot update mailbox queue env value");
	}
	return result.next;
}

function liveRaw(deps: MailboxQueueDeployBarrierDeps): string | null {
	return (deps.env ?? process.env)[MAILBOX_QUEUE_ENV_VAR] ?? null;
}

function setLiveRaw(
	deps: MailboxQueueDeployBarrierDeps,
	raw: string | null,
): void {
	const env = deps.env ?? process.env;
	if (raw === null) delete env[MAILBOX_QUEUE_ENV_VAR];
	else env[MAILBOX_QUEUE_ENV_VAR] = raw;
}

function operatorOverrideMarker(
	deps: MailboxQueueDeployBarrierDeps,
	marker: MailboxQueueDeployBarrierMarker,
	nextEnvRevision: string,
	reason: string,
): MailboxQueueDeployBarrierMarker {
	return {
		...marker,
		phase: "operator_override",
		ownershipToken: newOwnershipToken(deps),
		envRevision: nextEnvRevision,
		updatedAt: nowIso(deps),
		reason,
	};
}

/**
 * Called by the normal direct-toggle while it ALREADY holds `<env>.lock`.
 * OFF changes ownership before the env write (safe if that later write fails);
 * ON is denied while a deploy owns the barrier.
 */
export function prepareMailboxQueueOperatorToggleLocked(
	deps: MailboxQueueDeployBarrierDeps,
	rawTo: string | null,
	nextEnvContent: string,
): MailboxQueueDeployBarrierResult {
	const path = markerPath(deps);
	const marker = readMailboxQueueDeployBarrierMarker(path);
	if (!marker) return { ok: true, code: 0 };

	if (rawTo === "0") {
		writeMarkerAtomic(
			path,
			operatorOverrideMarker(
				deps,
				marker,
				computeEnvSha(nextEnvContent),
				"operator set mailbox queue OFF",
			),
		);
		return { ok: true, code: 0, ownershipInvalidated: true };
	}

	if (marker.phase === "operator_override") {
		// The operator who took ownership may explicitly turn the feature back ON.
		rmSync(path, { force: true });
		return { ok: true, code: 0 };
	}
	return {
		ok: false,
		code: 409,
		reason: "mailbox queue deploy readiness barrier owns the flag",
	};
}

export function beginMailboxQueueDeployBarrier(
	deps: MailboxQueueDeployBarrierDeps,
	targetSha: string,
): MailboxQueueDeployBarrierResult {
	const invalid = validateTargetSha(targetSha);
	if (invalid) return invalid;
	try {
		return underLock(deps, () => {
			const path = markerPath(deps);
			const current = readEnvContent(deps.envPath);
			const raw = rawFromContent(current);
			const revision = computeEnvSha(current);
			const existing = readMailboxQueueDeployBarrierMarker(path);

			if (existing) {
				if (existing.targetSha !== targetSha) {
					return {
						ok: false,
						code: 409,
						reason: `barrier belongs to ${existing.targetSha}`,
					};
				}
				if (existing.phase === "operator_override") {
					setLiveRaw(deps, raw);
					return {
						ok: true,
						code: 0,
						owned: false,
						operatorOff: raw === "0",
						phase: existing.phase,
					};
				}
				if (existing.phase === "released") {
					if (
						raw !== existing.priorRaw ||
						liveRaw(deps) !== existing.priorRaw
					) {
						return {
							ok: false,
							code: 409,
							reason: "released barrier does not match persistent/live env",
						};
					}
					rmSync(path, { force: true });
					return {
						ok: true,
						code: 0,
						owned: false,
						alreadyReleased: true,
						phase: "released",
					};
				}
				if (
					existing.phase === "releasing" &&
					existing.priorRaw !== "0" &&
					raw === existing.priorRaw &&
					liveRaw(deps) === existing.priorRaw
				) {
					// The Bridge wrote persistent+live ON and died before advancing
					// the marker. `releasing` is reachable only after all-ready CAS.
					rmSync(path, { force: true });
					return {
						ok: true,
						code: 0,
						owned: false,
						alreadyReleased: true,
						phase: "released",
					};
				}

				// Once OFF has been persisted, any env revision drift means another
				// canonical writer intervened. Never overwrite it on resume.
				if (
					existing.phase !== "preparing" &&
					(revision !== existing.envRevision || raw !== "0")
				) {
					const overridden = operatorOverrideMarker(
						deps,
						existing,
						revision,
						"env revision changed during deploy barrier",
					);
					writeMarkerAtomic(path, overridden);
					setLiveRaw(deps, raw);
					return {
						ok: true,
						code: 0,
						owned: false,
						operatorOff: raw === "0",
						phase: "operator_override",
					};
				}

				let next = current;
				if (raw !== "0") {
					// Preparing is marker-first: this is the expected recovery path if
					// the process died before persisting OFF.
					next = applyEnvRaw(current, "0");
					writeEnvFileAtomic(deps.envPath, next);
				}
				setLiveRaw(deps, "0");
				const resumed: MailboxQueueDeployBarrierMarker = {
					...existing,
					phase: "off_persisted",
					envRevision: computeEnvSha(next),
					updatedAt: nowIso(deps),
					reason: undefined,
				};
				writeMarkerAtomic(path, resumed);
				return {
					ok: true,
					code: 0,
					owned: true,
					token: resumed.ownershipToken,
					phase: resumed.phase,
				};
			}

			// Exact 0 without a marker belongs to the operator, never this deploy.
			if (raw === "0") {
				setLiveRaw(deps, "0");
				return {
					ok: true,
					code: 0,
					owned: false,
					operatorOff: true,
				};
			}

			const next = applyEnvRaw(current, "0");
			const marker: MailboxQueueDeployBarrierMarker = {
				schemaVersion: 1,
				targetSha,
				priorRaw: raw,
				phase: "preparing",
				ownershipToken: newOwnershipToken(deps),
				envRevision: computeEnvSha(next),
				updatedAt: nowIso(deps),
			};
			writeMarkerAtomic(path, marker); // marker FIRST — crash-safe ownership
			writeEnvFileAtomic(deps.envPath, next);
			setLiveRaw(deps, "0");
			const persisted = {
				...marker,
				phase: "off_persisted" as const,
				updatedAt: nowIso(deps),
			};
			writeMarkerAtomic(path, persisted);
			return {
				ok: true,
				code: 0,
				owned: true,
				token: persisted.ownershipToken,
				phase: persisted.phase,
			};
		});
	} catch (err) {
		return { ok: false, code: 500, reason: (err as Error).message };
	}
}

function updateOwnedOffMarker(
	deps: MailboxQueueDeployBarrierDeps,
	targetSha: string,
	token: string,
	phase: "ready" | "failed",
	message: string,
): MailboxQueueDeployBarrierResult {
	const invalid = validateTargetSha(targetSha);
	if (invalid) return invalid;
	try {
		return underLock(deps, () => {
			const path = markerPath(deps);
			const marker = readMailboxQueueDeployBarrierMarker(path);
			if (
				!marker ||
				marker.targetSha !== targetSha ||
				marker.ownershipToken !== token ||
				marker.phase === "operator_override"
			) {
				return { ok: false, code: 409, reason: "barrier ownership lost" };
			}
			const content = readEnvContent(deps.envPath);
			if (
				rawFromContent(content) !== "0" ||
				computeEnvSha(content) !== marker.envRevision ||
				liveRaw(deps) !== "0"
			) {
				return {
					ok: false,
					code: 409,
					reason: "barrier env/live CAS failed",
				};
			}
			writeMarkerAtomic(path, {
				...marker,
				phase,
				updatedAt: nowIso(deps),
				...(phase === "ready"
					? { readinessEvidence: message, reason: undefined }
					: { reason: message }),
			});
			return { ok: true, code: 0, owned: true, token, phase };
		});
	} catch (err) {
		return { ok: false, code: 500, reason: (err as Error).message };
	}
}

export function markMailboxQueueDeployBarrierReady(
	deps: MailboxQueueDeployBarrierDeps,
	targetSha: string,
	token: string,
	evidence: string,
): MailboxQueueDeployBarrierResult {
	if (!evidence.trim())
		return { ok: false, code: 400, reason: "evidence required" };
	return updateOwnedOffMarker(deps, targetSha, token, "ready", evidence);
}

export function holdMailboxQueueDeployBarrier(
	deps: MailboxQueueDeployBarrierDeps,
	targetSha: string,
	token: string,
	reason: string,
): MailboxQueueDeployBarrierResult {
	if (!reason.trim())
		return { ok: false, code: 400, reason: "reason required" };
	return updateOwnedOffMarker(deps, targetSha, token, "failed", reason);
}

export function releaseMailboxQueueDeployBarrier(
	deps: MailboxQueueDeployBarrierDeps,
	targetSha: string,
	token: string,
): MailboxQueueDeployBarrierResult {
	const invalid = validateTargetSha(targetSha);
	if (invalid) return invalid;
	try {
		const result = underLock(deps, () => {
			const path = markerPath(deps);
			const marker = readMailboxQueueDeployBarrierMarker(path);
			if (
				!marker ||
				marker.targetSha !== targetSha ||
				marker.ownershipToken !== token ||
				marker.phase === "operator_override"
			) {
				return {
					ok: false,
					code: 409,
					reason: "barrier ownership lost",
				} as const;
			}

			let content = readEnvContent(deps.envPath);
			let raw = rawFromContent(content);
			if (marker.phase === "released") {
				if (
					raw !== marker.priorRaw ||
					liveRaw(deps) !== marker.priorRaw ||
					computeEnvSha(content) !== marker.envRevision
				) {
					return {
						ok: false,
						code: 409,
						reason: "released barrier verification failed",
					} as const;
				}
				rmSync(path, { force: true });
				return { ok: true, code: 0, released: true } as const;
			}

			if (marker.phase === "failed") {
				return {
					ok: false,
					code: 409,
					reason: `barrier is held: ${marker.reason ?? "readiness failed"}`,
				} as const;
			}
			if (marker.phase !== "ready" && marker.phase !== "releasing") {
				return {
					ok: false,
					code: 409,
					reason: `barrier phase ${marker.phase} is not ready`,
				} as const;
			}

			if (marker.phase === "ready") {
				if (
					raw !== "0" ||
					liveRaw(deps) !== "0" ||
					computeEnvSha(content) !== marker.envRevision
				) {
					return {
						ok: false,
						code: 409,
						reason: "barrier release CAS failed",
					} as const;
				}
				writeMarkerAtomic(path, {
					...marker,
					phase: "releasing",
					updatedAt: nowIso(deps),
				});
			} else if (raw === "0" && computeEnvSha(content) !== marker.envRevision) {
				return {
					ok: false,
					code: 409,
					reason: "env revision changed while releasing barrier",
				} as const;
			}

			// `releasing` is deliberately idempotent: disk and live may each have
			// crossed the release seam before a process death.
			if (raw === "0") {
				content = applyEnvRaw(content, marker.priorRaw);
				writeEnvFileAtomic(deps.envPath, content);
				raw = marker.priorRaw;
			} else if (raw !== marker.priorRaw) {
				return {
					ok: false,
					code: 409,
					reason: "persistent env changed while releasing barrier",
				} as const;
			}
			setLiveRaw(deps, marker.priorRaw);
			const released: MailboxQueueDeployBarrierMarker = {
				...marker,
				phase: "released",
				envRevision: computeEnvSha(content),
				updatedAt: nowIso(deps),
			};
			writeMarkerAtomic(path, released);
			return { ok: true, code: 0, released: true } as const;
		});
		if (!result.ok) return result;

		// Marker deletion is a second locked step on purpose: a crash between the
		// release and cleanup leaves a self-describing `released` marker that the
		// next invocation verifies and removes without re-disabling the feature.
		return underLock(deps, () => {
			const path = markerPath(deps);
			const marker = readMailboxQueueDeployBarrierMarker(path);
			const content = readEnvContent(deps.envPath);
			if (!marker) return { ok: true, code: 0, released: true };
			if (
				marker.targetSha !== targetSha ||
				marker.ownershipToken !== token ||
				marker.phase !== "released" ||
				computeEnvSha(content) !== marker.envRevision ||
				rawFromContent(content) !== marker.priorRaw ||
				liveRaw(deps) !== marker.priorRaw
			) {
				return {
					ok: false,
					code: 409,
					reason: "release verification changed before marker cleanup",
				};
			}
			rmSync(path, { force: true });
			return { ok: true, code: 0, released: true };
		});
	} catch (err) {
		return { ok: false, code: 500, reason: (err as Error).message };
	}
}

/** Out-of-band fallback used when the console/Bridge is unavailable. */
export function applyMailboxQueueOperatorOff(
	deps: MailboxQueueDeployBarrierDeps & { reason: string },
): MailboxQueueDeployBarrierResult {
	try {
		return underLock(deps, () => {
			const content = readEnvContent(deps.envPath);
			const next = applyEnvRaw(content, "0");
			const prepared = prepareMailboxQueueOperatorToggleLocked(deps, "0", next);
			if (!prepared.ok) return prepared;
			writeEnvFileAtomic(deps.envPath, next);
			setLiveRaw(deps, "0");
			return {
				ok: true,
				code: 0,
				ownershipInvalidated: prepared.ownershipInvalidated ?? false,
			};
		});
	} catch (err) {
		return { ok: false, code: 500, reason: (err as Error).message };
	}
}
