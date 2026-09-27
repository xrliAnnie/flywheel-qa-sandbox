import { createHash } from "node:crypto";
import { canonicalJsonString } from "flywheel-config";

/**
 * FLY-2901: shared contract for the shared branch-B worktree takeover rescue.
 *
 * WorktreeManager (edge-worker) produces the manifest and drives the
 * transaction; the Bridge-local DirectEventSink (teamlead) persists the two
 * checked workflow events; the workflow-engine dispatcher computes the
 * "predecessor will not write again" permit. All three read these types so the
 * serialized bytes and event identities can never drift between packages.
 */

export const TAKEOVER_RESCUE_SCHEMA = "fly-2901.takeover-rescue.v1" as const;
export const TAKEOVER_RESCUED_EVENT_KIND = "worktree_takeover_rescued" as const;
export const TAKEOVER_CLEANED_EVENT_KIND = "worktree_takeover_cleaned" as const;
/** Bridge-global kill switch: true → today's refusal for registered failures. */
export const TAKEOVER_RESCUE_KILL_SWITCH_FLAG =
	"worktree_takeover_rescue_disabled" as const;

export type TakeoverRescueClass =
	| "dirty"
	| "nested_repo"
	| "head_behind"
	| "head_published_diverged"
	| "head_diverged"
	| "worktree_missing"
	/** Unregistered + absent path whose local branch carries unique commits. */
	| "unregistered_branch";

export type TakeoverPermitDenial =
	| "live_writer"
	| "zombie_writer"
	| "permit_indeterminate";

export interface TakeoverRescuePredecessor {
	executionId: string;
	sessionStatus: string | null;
	liveness: "alive" | "dead" | "unknown" | "not_probed";
	pathSource: "session" | "binding" | "both";
}

/**
 * Dispatcher-computed proof that no predecessor on the shared path can still
 * write. Absent on a Blueprint ctx ⇒ treated as `permit_indeterminate`.
 */
export interface TakeoverRescuePermit {
	allowed: boolean;
	reason: "no_live_writer" | TakeoverPermitDenial;
	predecessors: TakeoverRescuePredecessor[];
}

export type TakeoverRescueKind = "dirty" | "head" | "base";

export interface TakeoverRescueRef {
	kind: TakeoverRescueKind;
	/** refs/flywheel/rescue/<runId>/<pred>/<succ>/<stamp>/<kind> */
	localRef: string;
	/** flywheel-rescue/<issueKey>/<pred8>-<succ8>-<stamp>-<kind> */
	remoteBranch: string;
	tip: string;
}

export interface TakeoverNestedMove {
	/** Repo-relative path inside the shared worktree (no trailing slash). */
	relPath: string;
	source: string;
	destination: string;
	mode: "worktree_move" | "rename";
	head: string | null;
	statusDigest: string;
}

export interface TakeoverFingerprints {
	first: string;
	second: string;
	third: string;
}

export interface TakeoverRescueManifest {
	schema: typeof TAKEOVER_RESCUE_SCHEMA;
	runId: string;
	issueKey: string;
	successorExec: string;
	predecessors: TakeoverRescuePredecessor[];
	canonicalPath: string;
	branch: string;
	/** In place = current marker; missing = admin-area value; unregistered = null. */
	generationBefore: string | null;
	class: TakeoverRescueClass;
	startPoint: string;
	headBefore: string | null;
	target: string;
	remoteTip: string | null;
	rescues: TakeoverRescueRef[];
	snapshot: { stagedCommit: string; worktreeCommit: string } | null;
	nestedMoves: TakeoverNestedMove[];
	fingerprint3: string;
	fingerprints: TakeoverFingerprints;
	generationCarried: boolean;
	stamp: string;
	at: string;
}

/** Identity fields copied into the event payload and cross-checked on re-entry. */
export const TAKEOVER_MANIFEST_IDENTITY_FIELDS = [
	"canonicalPath",
	"branch",
	"generationBefore",
	"class",
	"target",
	"fingerprint3",
	"rescues",
	"nestedMoves",
] as const;

export interface TakeoverRescueEventPayload {
	schema: typeof TAKEOVER_RESCUE_SCHEMA;
	runId: string;
	successorExec: string;
	manifestPath: string;
	/** sha256 of the manifest file's exact bytes (never stored in the manifest). */
	manifestSha256: string;
	canonicalPath: string;
	branch: string;
	generationBefore: string | null;
	class: TakeoverRescueClass;
	target: string;
	fingerprint3: string;
	rescues: TakeoverRescueRef[];
	nestedMoves: TakeoverNestedMove[];
}

export interface TakeoverCleanedEventPayload {
	schema: typeof TAKEOVER_RESCUE_SCHEMA;
	rescueEventUid: string;
	manifestSha256: string;
	canonicalPath: string;
	target: string;
	generationAfter: string | null;
	completedBy: string;
}

export interface PendingTakeoverRescue {
	eventUid: string;
	seq: number;
	payload: TakeoverRescueEventPayload;
}

/**
 * Bridge-local two-way capability handed to the takeover transaction. Every
 * method is awaited; a throw stops the transaction before any destructive step.
 */
export interface TakeoverRescueRecorder {
	/** All rescued-but-not-cleaned events for this run and canonical path. */
	loadPendingTakeoverRescue(input: {
		runId: string;
		canonicalPath: string;
	}): Promise<PendingTakeoverRescue[]>;
	recordRescue(input: {
		runId: string;
		eventUid: string;
		payload: TakeoverRescueEventPayload;
	}): Promise<void>;
	recordCleaned(input: {
		runId: string;
		rescueEventUid: string;
		payload: TakeoverCleanedEventPayload;
	}): Promise<void>;
}

const KIND_ORDER: Record<TakeoverRescueKind, number> = {
	base: 0,
	dirty: 1,
	head: 2,
};

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function sortTakeoverRescues(
	rescues: readonly TakeoverRescueRef[],
): TakeoverRescueRef[] {
	return [...rescues].sort(
		(left, right) =>
			KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
			compareText(left.remoteBranch, right.remoteBranch),
	);
}

export function sortTakeoverNestedMoves(
	moves: readonly TakeoverNestedMove[],
): TakeoverNestedMove[] {
	return [...moves].sort(
		(left, right) =>
			compareText(left.relPath, right.relPath) ||
			compareText(left.destination, right.destination),
	);
}

function normalizeManifest(
	manifest: TakeoverRescueManifest,
): TakeoverRescueManifest {
	return {
		...manifest,
		rescues: sortTakeoverRescues(manifest.rescues),
		nestedMoves: sortTakeoverNestedMoves(manifest.nestedMoves),
	};
}

/**
 * The manifest's exact on-disk bytes: recursive key-sorted canonical JSON plus
 * one trailing newline. The digest is taken over these bytes and lives only in
 * the event payload (R4 #1 / R5).
 */
export function serializeTakeoverManifest(
	manifest: TakeoverRescueManifest,
): Buffer {
	return Buffer.from(
		`${canonicalJsonString(normalizeManifest(manifest))}\n`,
		"utf8",
	);
}

export function sha256Hex(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function takeoverRescueEventUid(input: {
	runId: string;
	successorExec: string;
	tips: readonly string[];
	target: string;
}): string {
	const tips = [...new Set(input.tips.map((tip) => tip.toLowerCase()))].sort();
	return `${TAKEOVER_RESCUED_EVENT_KIND}:${sha256Hex(
		canonicalJsonString({
			runId: input.runId,
			successorExec: input.successorExec,
			target: input.target.toLowerCase(),
			tips,
		}),
	)}`;
}

export function takeoverCleanedEventUid(rescueEventUid: string): string {
	return `cleaned:${rescueEventUid}`;
}

export function buildTakeoverEventPayload(
	manifest: TakeoverRescueManifest,
	manifestPath: string,
	manifestSha256: string,
): TakeoverRescueEventPayload {
	const normalized = normalizeManifest(manifest);
	return {
		schema: TAKEOVER_RESCUE_SCHEMA,
		runId: normalized.runId,
		successorExec: normalized.successorExec,
		manifestPath,
		manifestSha256,
		canonicalPath: normalized.canonicalPath,
		branch: normalized.branch,
		generationBefore: normalized.generationBefore,
		class: normalized.class,
		target: normalized.target,
		fingerprint3: normalized.fingerprint3,
		rescues: normalized.rescues,
		nestedMoves: normalized.nestedMoves,
	};
}

export type TakeoverManifestVerification =
	| { ok: true; manifest: TakeoverRescueManifest }
	| { ok: false; detail: string };

/**
 * Re-entry check: exact-byte digest first, then parse, then field-by-field
 * cross-check of every identity field against the event copy.
 */
export function verifyTakeoverManifestAgainstEvent(
	bytes: Buffer,
	payload: TakeoverRescueEventPayload,
): TakeoverManifestVerification {
	if (sha256Hex(bytes) !== payload.manifestSha256) {
		return { ok: false, detail: "manifest_digest_mismatch" };
	}
	let manifest: TakeoverRescueManifest;
	try {
		manifest = JSON.parse(bytes.toString("utf8")) as TakeoverRescueManifest;
	} catch {
		return { ok: false, detail: "manifest_unparseable" };
	}
	if (manifest?.schema !== TAKEOVER_RESCUE_SCHEMA) {
		return { ok: false, detail: "manifest_schema_mismatch" };
	}
	if (
		manifest.runId !== payload.runId ||
		manifest.successorExec !== payload.successorExec
	) {
		return { ok: false, detail: "manifest_identity_mismatch:owner" };
	}
	for (const field of TAKEOVER_MANIFEST_IDENTITY_FIELDS) {
		if (
			canonicalJsonString(manifest[field] ?? null) !==
			canonicalJsonString(payload[field] ?? null)
		) {
			return { ok: false, detail: `manifest_identity_mismatch:${field}` };
		}
	}
	return { ok: true, manifest };
}

/**
 * Progress-ledger `rescue` pointer value (always non-empty):
 * `event:<uid>` plus ` refs:<remoteBranch>@<tip>,…` (kind order) when refs exist.
 */
export function encodeRescuePointer(
	eventUid: string,
	rescues: readonly TakeoverRescueRef[],
): string {
	const refs = sortTakeoverRescues(rescues).map(
		(rescue) => `${rescue.remoteBranch}@${rescue.tip}`,
	);
	return refs.length > 0
		? `event:${eventUid} refs:${refs.join(",")}`
		: `event:${eventUid}`;
}
