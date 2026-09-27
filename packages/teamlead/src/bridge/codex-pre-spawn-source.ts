import type {
	CodexPreSpawnFailureReceipt,
	CodexPreSpawnSourceSnapshot,
	StateStore,
} from "../StateStore.js";

export interface TrustedCodexPreSpawnSource {
	executionId: string;
	projectName: string;
	issueId: string;
	executionRunId: string;
	activationId: string;
	lifecycleRevision: number;
	sourceEventId: string;
	origin: "live_preflight" | "legacy_compat";
	failureCode:
		| "auth_preflight_failed"
		| "source_auth_unavailable"
		| "source_identity_unknown";
	proofDigest: string;
	terminalAt: string;
	observedAt: string;
}

export type CodexPreSpawnSourceDecision =
	| { status: "valid"; source: TrustedCodexPreSpawnSource }
	| {
			status: "candidate";
			origin: "legacy_compat";
			failureCode: "source_auth_unavailable" | "source_identity_unknown";
			observedAt: string;
	  }
	| { status: "ineligible" | "unknown"; reason: string };

export interface CodexPreSpawnSourceOptions {
	now?: () => Date;
	/** Read-only inventory must not create a legacy compatibility receipt. */
	dryRun?: boolean;
}

const DIGEST = /^[0-9a-f]{64}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseUtc(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value)
		? value
		: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
			? `${value.replace(" ", "T")}Z`
			: undefined;
	if (!normalized) return undefined;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function activeLaunchOwner(
	snapshot: CodexPreSpawnSourceSnapshot,
	nowMs: number,
): boolean {
	const owner = snapshot.launchOwner;
	if (!owner || owner.committed_generation !== null) return false;
	if ((owner.released_generation ?? 0) >= owner.owner_generation) return false;
	const lease = parseUtc(owner.lease_expires_at);
	return lease === undefined || lease > nowMs;
}

function durableReceiptMatches(
	snapshot: CodexPreSpawnSourceSnapshot,
	receipt: CodexPreSpawnFailureReceipt,
): boolean {
	const { session, activation, terminal } = snapshot;
	return Boolean(
		session &&
			activation &&
			terminal &&
			snapshot.activationState === "current" &&
			snapshot.launchClaimState === "closed" &&
			session.adapterType === "codex-tmux" &&
			(session.status === "failed" || session.status === "blocked") &&
			receipt.invalidatedAt === null &&
			receipt.executionId === snapshot.executionId &&
			receipt.projectName === session.projectName &&
			receipt.issueId === session.issueId &&
			receipt.executionRunId === activation.executionRunId &&
			receipt.activationId === activation.activationId &&
			receipt.lifecycleRevision === session.lifecycleRevision &&
			receipt.sourceEventId === terminal.sourceEventId &&
			terminal.issueId === session.issueId &&
			terminal.projectName === session.projectName &&
			terminal.sessionEventSource === "direct-event-sink" &&
			DIGEST.test(receipt.proofDigest) &&
			parseUtc(receipt.terminalAt) !== undefined,
	);
}

function legacyTerminalFailure(snapshot: CodexPreSpawnSourceSnapshot):
	| {
			failureCode: "source_auth_unavailable" | "source_identity_unknown";
			terminalAt: string;
	  }
	| undefined {
	const { session, activation, terminal, policy } = snapshot;
	if (
		!session ||
		!activation ||
		!terminal ||
		!policy ||
		snapshot.activationState !== "current" ||
		snapshot.launchClaimState !== "closed" ||
		session.adapterType !== "codex-tmux" ||
		(session.status !== "failed" && session.status !== "blocked") ||
		terminal.issueId !== session.issueId ||
		terminal.projectName !== session.projectName ||
		terminal.sessionEventSource !== "direct-event-sink"
	) {
		return undefined;
	}
	const event = record(terminal.sessionPayload);
	const teardown = record(terminal.teardownPayload);
	if (
		!event ||
		!teardown ||
		(event.failureKind ?? null) !== null ||
		(event.lastError ?? null) !== session.lastError ||
		teardown.sourceEventId !== terminal.sourceEventId ||
		teardown.signal !== "failed" ||
		teardown.status !== "failed" ||
		teardown.effectiveStatus !== "failed" ||
		teardown.statusPreserved !== false ||
		(teardown.failureKind ?? null) !== null
	) {
		return undefined;
	}
	const message = session.lastError;
	const failureCode =
		typeof message === "string" &&
		/^Codex source auth is unavailable at [^:\r\n]+: .+$/u.test(message)
			? ("source_auth_unavailable" as const)
			: typeof message === "string" &&
					/^unknown Codex account identity: [^\r\n]+$/u.test(message)
				? ("source_identity_unknown" as const)
				: undefined;
	if (!failureCode) return undefined;
	const terminalAt = teardown.at;
	const terminalMs = parseUtc(terminalAt);
	const eventMs = parseUtc(terminal.sessionEventTs);
	const cutoffMs = parseUtc(policy.cutoffAt);
	if (
		typeof terminalAt !== "string" ||
		terminalMs === undefined ||
		eventMs === undefined ||
		cutoffMs === undefined ||
		terminalMs >= cutoffMs ||
		Math.floor(terminalMs / 1_000) !== Math.floor(eventMs / 1_000)
	) {
		return undefined;
	}
	return { failureCode, terminalAt };
}

function trustedSource(
	receipt: CodexPreSpawnFailureReceipt,
	observedAt: string,
): TrustedCodexPreSpawnSource {
	return {
		executionId: receipt.executionId,
		projectName: receipt.projectName,
		issueId: receipt.issueId,
		executionRunId: receipt.executionRunId,
		activationId: receipt.activationId,
		lifecycleRevision: receipt.lifecycleRevision,
		sourceEventId: receipt.sourceEventId,
		origin: receipt.origin,
		failureCode: receipt.failureCode,
		proofDigest: receipt.proofDigest,
		terminalAt: receipt.terminalAt,
		observedAt,
	};
}

/**
 * Qualifies only the trusted failure source.  A caller must still obtain a
 * current shared-provider closure for owner, spawn-inflight, socket, and lock
 * state before constructing a dead NeverStartedBodyObservation.
 */
export function resolveCodexPreSpawnSource(
	store: StateStore,
	executionId: string,
	projectName: string,
	options: CodexPreSpawnSourceOptions = {},
): CodexPreSpawnSourceDecision {
	const observedAt = (options.now ?? (() => new Date()))();
	const initial = store.getCodexPreSpawnSourceSnapshot(executionId);
	if (!initial.policy)
		return { status: "unknown", reason: "policy_not_initialized" };
	if (initial.session?.projectName !== projectName) {
		return { status: "ineligible", reason: "project_identity_mismatch" };
	}
	if (activeLaunchOwner(initial, observedAt.getTime())) {
		return { status: "unknown", reason: "launch_owner_active" };
	}

	if (initial.receipt) {
		return durableReceiptMatches(initial, initial.receipt)
			? {
					status: "valid",
					source: trustedSource(initial.receipt, observedAt.toISOString()),
				}
			: { status: "unknown", reason: "receipt_identity_mismatch" };
	}
	const legacy = legacyTerminalFailure(initial);
	if (!legacy) {
		return { status: "ineligible", reason: "terminal_source_ineligible" };
	}
	if (options.dryRun) {
		return {
			status: "candidate",
			origin: "legacy_compat",
			failureCode: legacy.failureCode,
			observedAt: observedAt.toISOString(),
		};
	}
	const written = store.recordLegacyCodexPreSpawnFailureReceipt({
		executionId,
		expectedSnapshotDigest: initial.snapshotDigest,
		failureCode: legacy.failureCode,
		terminalAt: legacy.terminalAt,
		now: observedAt.toISOString(),
	});
	if (!written.ok) return { status: "unknown", reason: written.reason };
	const current = store.getCodexPreSpawnSourceSnapshot(executionId);
	return durableReceiptMatches(current, written.receipt)
		? {
				status: "valid",
				source: trustedSource(written.receipt, observedAt.toISOString()),
			}
		: { status: "unknown", reason: "receipt_identity_mismatch" };
}
