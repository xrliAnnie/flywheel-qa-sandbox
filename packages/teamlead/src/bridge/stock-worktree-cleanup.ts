import { createHash } from "node:crypto";
import type { BodyObservation } from "./execution-body-observation-contract.js";

export type StockCleanupPrState = "MERGED" | "CLOSED" | "OPEN" | "UNKNOWN";

export interface StockCleanupObservedTarget {
	projectName: string;
	repoSlug: string;
	canonicalPath: string;
	parentIdentity?: { dev: string; ino: string };
	leafIdentity?: { dev: string; ino: string };
	generation?: string;
	branch?: string;
	head?: string;
	locked: boolean;
	detached: boolean;
	issueId?: string;
	issueIdentifier?: string;
	operationId?: string;
	pr?: {
		number: number;
		state: StockCleanupPrState;
		headRef?: string;
		headSha?: string;
		baseRef?: string;
		mergeCommitSha?: string;
		mergedAt?: string;
	};
	bindings: Array<{
		executionId: string;
		activationId?: string;
		path: string;
		branch: string;
		generation: string;
	}>;
	bodyObservations: BodyObservation[];
	bindinglessProviderProof?: {
		source: string | null;
		ownership: string | null;
		socket: string | null;
		lock: string | null;
	};
	clean?: boolean;
	nestedRepository: "clear" | "present" | "unknown";
	remoteProof:
		| {
				state: "preserved";
				kind: "merged_exact_head" | "remote_ref_contains_head";
				observedHead: string;
				observedAt: string;
		  }
		| { state: "missing" | "unknown"; reason: string };
	processCensus:
		| { state: "clear"; observedAt: string }
		| { state: "present"; observedAt: string; pids: number[] }
		| { state: "unknown"; reason: string };
	terminalAuthority:
		| { state: "valid"; identity: string }
		| { state: "missing" | "changed"; reason: string };
}

export type StockCleanupExclusionReason =
	| "project_scope_mismatch"
	| "preserved_sample"
	| "worktree_locked"
	| "detached_head"
	| "protected_branch"
	| "identity_conflict"
	| "untrusted_binding"
	| "bindingless_provider_source_missing"
	| "bindingless_provider_ownership_missing"
	| "bindingless_provider_socket_missing"
	| "bindingless_provider_lock_missing"
	| "pr_missing"
	| "pr_open"
	| "pr_unknown"
	| "pr_identity_conflict"
	| "body_alive"
	| "body_unknown"
	| "dirty"
	| "worktree_status_unknown"
	| "nested_repository"
	| "nested_scan_unknown"
	| "remote_proof_missing"
	| "remote_proof_unknown"
	| "process_present"
	| "process_census_unknown"
	| "terminal_authority_missing"
	| "authority_changed";

export interface StockCleanupManifestTarget extends StockCleanupObservedTarget {
	eligible: boolean;
	exclusionReasons: StockCleanupExclusionReason[];
}

export interface StockCleanupManifest {
	schemaVersion: 1;
	projectName: string;
	observedAt: string;
	counts: {
		registered: number;
		rawMergedClosed: number;
		dirty: number;
		unpushed: number;
		live: number;
		unknown: number;
		preserved: number;
		identityConflict: number;
		processPresent: number;
		processCensusUnknown: number;
		nestedRepository: number;
		legacyEvidenceMissing: number;
		terminalAuthorityMissing: number;
		bindinglessCohort: number;
		eligible: number;
	};
	targets: StockCleanupManifestTarget[];
}

const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "production"]);
const PRESERVED_ISSUES = new Set(["FLY-2688", "FLY-2751"]);
const SHA = /^[0-9a-f]{40}$/i;

function push(
	reasons: StockCleanupExclusionReason[],
	reason: StockCleanupExclusionReason,
): void {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function bodyReasons(
	target: StockCleanupObservedTarget,
	reasons: StockCleanupExclusionReason[],
	observedAt: string,
): void {
	if (target.bindings.length === 0) return;
	for (const binding of target.bindings) {
		const observation = target.bodyObservations.find(
			(candidate) =>
				candidate.identity.executionId === binding.executionId &&
				(!binding.activationId ||
					candidate.identity.activationId === binding.activationId),
		);
		if (!observation) {
			push(reasons, "body_unknown");
			continue;
		}
		if (observation.verdict === "alive") push(reasons, "body_alive");
		if (
			observation.verdict === "unknown" ||
			!observation.expiresAt ||
			observation.expiresAt <= observedAt
		) {
			push(reasons, "body_unknown");
		}
	}
}

function identityReasons(
	target: StockCleanupObservedTarget,
	reasons: StockCleanupExclusionReason[],
): void {
	if (
		!target.parentIdentity ||
		!target.leafIdentity ||
		!target.generation ||
		!target.branch ||
		!SHA.test(target.head ?? "")
	) {
		push(reasons, "identity_conflict");
	}
	for (const binding of target.bindings) {
		if (
			binding.path !== target.canonicalPath ||
			binding.branch !== target.branch ||
			binding.generation !== target.generation
		) {
			push(reasons, "identity_conflict");
		}
	}
	if (
		target.pr &&
		(target.pr.headRef !== target.branch ||
			!target.pr.headSha ||
			target.pr.headSha.toLowerCase() !== target.head?.toLowerCase())
	) {
		push(reasons, "pr_identity_conflict");
	}
}

function bindinglessReasons(
	target: StockCleanupObservedTarget,
	reasons: StockCleanupExclusionReason[],
): void {
	if (target.bindings.length > 0) return;
	push(reasons, "untrusted_binding");
	const proof = target.bindinglessProviderProof;
	if (!proof?.source) push(reasons, "bindingless_provider_source_missing");
	if (!proof?.ownership)
		push(reasons, "bindingless_provider_ownership_missing");
	if (!proof?.socket) push(reasons, "bindingless_provider_socket_missing");
	if (!proof?.lock) push(reasons, "bindingless_provider_lock_missing");
}

function evaluate(
	target: StockCleanupObservedTarget,
	projectName: string,
	observedAt: string,
): StockCleanupManifestTarget {
	const reasons: StockCleanupExclusionReason[] = [];
	if (target.projectName !== projectName)
		push(reasons, "project_scope_mismatch");
	if (PRESERVED_ISSUES.has(target.issueIdentifier ?? ""))
		push(reasons, "preserved_sample");
	if (target.locked) push(reasons, "worktree_locked");
	if (target.detached) push(reasons, "detached_head");
	if (PROTECTED_BRANCHES.has(target.branch ?? ""))
		push(reasons, "protected_branch");

	identityReasons(target, reasons);
	bindinglessReasons(target, reasons);

	if (!target.pr) push(reasons, "pr_missing");
	else if (target.pr.state === "OPEN") push(reasons, "pr_open");
	else if (target.pr.state === "UNKNOWN") push(reasons, "pr_unknown");
	else if (target.pr.state === "MERGED") {
		if (
			!target.pr.mergedAt ||
			!target.pr.baseRef ||
			!SHA.test(target.pr.mergeCommitSha ?? "")
		) {
			push(reasons, "pr_identity_conflict");
		}
	}

	bodyReasons(target, reasons, observedAt);
	if (target.clean === false) push(reasons, "dirty");
	else if (target.clean !== true) push(reasons, "worktree_status_unknown");
	if (target.nestedRepository === "present") push(reasons, "nested_repository");
	else if (target.nestedRepository === "unknown")
		push(reasons, "nested_scan_unknown");
	if (target.remoteProof.state === "missing")
		push(reasons, "remote_proof_missing");
	else if (target.remoteProof.state === "unknown")
		push(reasons, "remote_proof_unknown");
	if (target.processCensus.state === "present")
		push(reasons, "process_present");
	else if (target.processCensus.state === "unknown")
		push(reasons, "process_census_unknown");
	if (target.terminalAuthority.state === "missing")
		push(reasons, "terminal_authority_missing");
	else if (target.terminalAuthority.state === "changed")
		push(reasons, "authority_changed");

	return {
		...target,
		eligible: reasons.length === 0,
		exclusionReasons: reasons,
	};
}

export function buildStockCleanupPreview(input: {
	projectName: string;
	observedAt: string;
	targets: StockCleanupObservedTarget[];
}): {
	manifest: StockCleanupManifest;
	manifestJson: string;
	manifestDigest: string;
} {
	const targets = input.targets
		.map((target) => evaluate(target, input.projectName, input.observedAt))
		.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
	const has = (
		target: StockCleanupManifestTarget,
		reason: StockCleanupExclusionReason,
	) => target.exclusionReasons.includes(reason);
	const unknownReasons = new Set<StockCleanupExclusionReason>([
		"body_unknown",
		"worktree_status_unknown",
		"nested_scan_unknown",
		"remote_proof_unknown",
		"process_census_unknown",
		"terminal_authority_missing",
		"bindingless_provider_source_missing",
		"bindingless_provider_ownership_missing",
		"bindingless_provider_socket_missing",
		"bindingless_provider_lock_missing",
	]);
	const manifest: StockCleanupManifest = {
		schemaVersion: 1,
		projectName: input.projectName,
		observedAt: input.observedAt,
		counts: {
			registered: targets.length,
			rawMergedClosed: targets.filter(
				(target) =>
					target.pr?.state === "MERGED" || target.pr?.state === "CLOSED",
			).length,
			dirty: targets.filter((target) => has(target, "dirty")).length,
			unpushed: targets.filter(
				(target) =>
					has(target, "remote_proof_missing") ||
					has(target, "remote_proof_unknown"),
			).length,
			live: targets.filter(
				(target) => has(target, "body_alive") || has(target, "process_present"),
			).length,
			unknown: targets.filter((target) =>
				target.exclusionReasons.some((reason) => unknownReasons.has(reason)),
			).length,
			preserved: targets.filter((target) => has(target, "preserved_sample"))
				.length,
			identityConflict: targets.filter(
				(target) =>
					has(target, "identity_conflict") ||
					has(target, "pr_identity_conflict") ||
					has(target, "project_scope_mismatch"),
			).length,
			processPresent: targets.filter((target) => has(target, "process_present"))
				.length,
			processCensusUnknown: targets.filter((target) =>
				has(target, "process_census_unknown"),
			).length,
			nestedRepository: targets.filter((target) =>
				has(target, "nested_repository"),
			).length,
			legacyEvidenceMissing: targets.filter((target) =>
				target.exclusionReasons.some((reason) =>
					reason.startsWith("bindingless_provider_"),
				),
			).length,
			terminalAuthorityMissing: targets.filter((target) =>
				has(target, "terminal_authority_missing"),
			).length,
			bindinglessCohort: targets.filter(
				(target) => target.bindings.length === 0,
			).length,
			eligible: targets.filter((target) => target.eligible).length,
		},
		targets,
	};
	const manifestJson = JSON.stringify(manifest);
	return {
		manifest,
		manifestJson,
		manifestDigest: createHash("sha256")
			.update(manifestJson, "utf8")
			.digest("hex"),
	};
}
