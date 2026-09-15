import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { validatePatrolReport as validateReportStructure } from "./patrol-report.js";
import { acquireProcessLifetimeFileLock } from "./process-lock.js";

export interface ContinuityIdentity {
	project: string;
	lead: string;
	executionId: string;
	activationId: string;
	runId: string | null;
	nodeId: string | null;
	attempt: number | null;
	turnEpoch: number | null;
	bindingGeneration: string;
	repoSourceIdentity: string;
}
export interface SemanticState {
	sessionStatus: string;
	sessionStage: string | null;
	nodeState: string | null;
	turnRelation: string;
	effectiveWait: { kind: string; id: string } | null;
}
export interface ContinuityRef {
	repoIdentity: string;
	fullRef: string;
	headSha: string;
	observedAtMs: number;
}
export interface ContinuityObservation {
	identity: ContinuityIdentity;
	sampledAtMs: number;
	semanticState: SemanticState;
	refs: ContinuityRef[];
	sourcesComplete: boolean;
	ownershipComplete: boolean;
	eventsComplete: boolean;
	canAttributeRemote: boolean;
	reason?: string;
	semanticTransitions?: Array<{ atMs: number; state: SemanticState }>;
	sourceCursors: { stageEventId: number; workflowEventSeq: number };
}
export interface ContinuityEntry {
	canAttributeRemote: boolean;
	identity: ContinuityIdentity;
	semanticState: SemanticState;
	semanticDigest: string;
	observedSinceMs: number;
	lastStateChangeAtMs: number | null;
	lastProgressObservedAtMs: number | null;
	lastSuccessfulObservationAtMs: number;
	coverageSinceMs: number;
	sourcesComplete: boolean;
	sourceCursors: ContinuityObservation["sourceCursors"];
	refs: ContinuityRef[];
	lastVeto: {
		fromMs: number;
		toMs: number;
		source: string;
		oldHead: string;
		newHead: string;
	} | null;
}
export interface ContinuityResult {
	key: string;
	activity: "ACTIVE" | "WAITING" | "OBSERVING" | "UNKNOWN" | "STALLED_60M";
	reason: string;
	entry: ContinuityEntry | undefined;
	last_change_epoch: number;
	last_change_basis: "baseline" | "state_transition" | "remote_head";
	interval_start: number;
	interval_end: number;
	branch_activity: boolean;
}
export function continuityDigest(value: unknown): string {
	function canonical(v: unknown): unknown {
		if (Array.isArray(v)) return v.map(canonical);
		if (v !== null && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, val]) => [k, canonical(val)]),
			);
		return v;
	}
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
export function evaluateContinuity(
	previous: ContinuityEntry | undefined,
	current: ContinuityObservation,
): ContinuityResult {
	const now = current.sampledAtMs;
	const key = continuityDigest(current.identity);
	const same =
		previous !== undefined && continuityDigest(previous.identity) === key;
	const prior = same ? previous : undefined;
	const base = prior?.observedSinceMs ?? now;
	let entry: ContinuityEntry | undefined = prior;
	let basis: ContinuityResult["last_change_basis"] = "baseline";
	let branchActivity = false;
	function finish(
		activity: ContinuityResult["activity"],
		reason: string,
	): ContinuityResult {
		const last = Math.max(
			entry?.observedSinceMs ?? now,
			entry?.lastStateChangeAtMs ?? 0,
			entry?.lastProgressObservedAtMs ?? 0,
		);
		if (
			entry?.lastProgressObservedAtMs != null &&
			entry.lastProgressObservedAtMs === last
		)
			basis = "remote_head";
		else if (
			entry?.lastStateChangeAtMs != null &&
			entry.lastStateChangeAtMs === last
		)
			basis = "state_transition";
		return {
			key,
			activity,
			reason,
			entry,
			last_change_epoch: Math.floor(last / 1000),
			last_change_basis: basis,
			interval_start: Math.floor(
				Math.max(entry?.coverageSinceMs ?? now, last) / 1000,
			),
			interval_end: Math.floor(now / 1000),
			branch_activity: branchActivity,
		};
	}
	function unknown(reason: string): ContinuityResult {
		// A failed observation breaks negative coverage without inventing progress.
		if (entry)
			entry = { ...entry, sourcesComplete: false, coverageSinceMs: now };
		return finish("UNKNOWN", reason);
	}
	if (!Number.isSafeInteger(now) || now <= 0) return unknown("clock_invalid");
	if (
		prior &&
		(prior.lastSuccessfulObservationAtMs > now || prior.observedSinceMs > now)
	)
		return unknown("clock_rollback");
	if (!current.ownershipComplete)
		return unknown(current.reason ?? "identity_incomplete");
	if (
		!current.semanticState ||
		!current.identity.executionId ||
		!current.identity.activationId
	)
		return unknown("state_incomplete");
	const validRefs = current.refs.filter(
		(r) =>
			/^[a-f0-9]{40}$/i.test(r.headSha) &&
			r.fullRef.startsWith("refs/heads/") &&
			r.repoIdentity &&
			Number.isSafeInteger(r.observedAtMs) &&
			r.observedAtMs <= now &&
			r.observedAtMs > 0,
	);
	const refsComplete =
		validRefs.length > 0 && validRefs.length === current.refs.length;
	const changed =
		prior &&
		validRefs.find((ref) =>
			prior.refs.some(
				(old) =>
					old.repoIdentity === ref.repoIdentity &&
					old.fullRef === ref.fullRef &&
					old.headSha !== ref.headSha,
			),
		);
	branchActivity = !!changed;
	const gap =
		prior !== undefined &&
		now - prior.lastSuccessfulObservationAtMs > 90 * 60 * 1000;
	const complete =
		current.sourcesComplete && current.eventsComplete && refsComplete;
	const digest = continuityDigest(current.semanticState);
	let stateChanged = !!prior && prior.semanticDigest !== digest;
	let stateChangeAt = stateChanged ? now : (prior?.lastStateChangeAtMs ?? null);
	if (prior && current.semanticTransitions?.length) {
		let lastState = prior.semanticDigest;
		let lastTime = prior.lastSuccessfulObservationAtMs;
		for (const transition of current.semanticTransitions) {
			if (
				!Number.isSafeInteger(transition.atMs) ||
				transition.atMs < lastTime ||
				transition.atMs > now
			)
				return unknown("event_interval_invalid");
			const next = continuityDigest(transition.state);
			if (next !== lastState) {
				stateChanged = true;
				stateChangeAt = Math.max(stateChangeAt ?? 0, transition.atMs);
			}
			lastState = next;
			lastTime = transition.atMs;
		}
		if (lastState !== digest) return unknown("event_state_mismatch");
	}
	entry = {
		canAttributeRemote: current.canAttributeRemote,
		identity: current.identity,
		semanticState: current.semanticState,
		semanticDigest: digest,
		observedSinceMs: base,
		lastStateChangeAtMs: stateChangeAt,
		lastProgressObservedAtMs: prior?.lastProgressObservedAtMs ?? null,
		lastSuccessfulObservationAtMs: now,
		coverageSinceMs:
			!prior || !prior.sourcesComplete || gap ? now : prior.coverageSinceMs,
		sourcesComplete: complete && !gap,
		sourceCursors: current.sourceCursors,
		refs: validRefs,
		lastVeto: prior?.lastVeto ?? null,
	};
	// Only the exact writer throughout the observation interval owns branch progress.
	if (
		changed &&
		current.canAttributeRemote &&
		prior?.canAttributeRemote &&
		prior?.semanticState.turnRelation === current.semanticState.turnRelation
	) {
		const old = prior.refs.find(
			(r) =>
				r.repoIdentity === changed.repoIdentity &&
				r.fullRef === changed.fullRef,
		)!;
		entry.lastProgressObservedAtMs = now;
		entry.lastVeto = {
			fromMs: prior.lastSuccessfulObservationAtMs,
			toMs: now,
			source: "remote_ref",
			oldHead: old.headSha,
			newHead: changed.headSha,
		};
		return finish("ACTIVE", "remote_head_changed");
	}
	if (stateChanged) return finish("ACTIVE", "state_transition");
	const recent = Math.max(
		entry.lastProgressObservedAtMs ?? 0,
		entry.lastStateChangeAtMs ?? 0,
	);
	if (recent > 0 && now - recent < 3600000)
		return finish("ACTIVE", "recent_progress");
	if (current.semanticState.effectiveWait)
		return finish("WAITING", "effective_wait");
	if (changed) return unknown("remote_attribution_ambiguous");
	if (!complete)
		return unknown(
			current.reason ??
				(!refsComplete ? "ref_incomplete" : "source_incomplete"),
		);
	if (gap) return unknown("coverage_gap");
	const elapsed =
		now -
		Math.max(
			base,
			entry.lastProgressObservedAtMs ?? 0,
			entry.lastStateChangeAtMs ?? 0,
			entry.coverageSinceMs,
		);
	return finish(
		elapsed >= 3600000 ? "STALLED_60M" : "OBSERVING",
		elapsed >= 3600000 ? "no_observed_progress" : "coverage_baseline",
	);
}

export interface ContinuitySidecar {
	version: 2;
	project: string;
	lead: string;
	sampledAtMs: number;
	entries: Record<string, ContinuityEntry>;
}
export interface SampleContinuityInput {
	path: string;
	project: string;
	lead: string;
	nowMs: number;
	executionIds: string[];
	inventoryComplete?: boolean;
	collect: (
		previous: Record<string, ContinuityEntry>,
		signal: AbortSignal,
	) => Promise<ContinuityObservation[]>;
	acquireLock?: typeof acquireProcessLifetimeFileLock;
}
export interface ContinuityBatch {
	facts: Record<string, ContinuityResult>;
	published: boolean;
}
export function validSidecar(
	value: unknown,
	input: Pick<SampleContinuityInput, "project" | "lead" | "nowMs">,
): value is ContinuitySidecar {
	if (!value || typeof value !== "object") return false;
	const doc = value as ContinuitySidecar;
	if (
		doc.version !== 2 ||
		doc.project !== input.project ||
		doc.lead !== input.lead ||
		!Number.isSafeInteger(doc.sampledAtMs) ||
		doc.sampledAtMs > input.nowMs ||
		doc.sampledAtMs <= 0 ||
		!doc.entries ||
		typeof doc.entries !== "object" ||
		Array.isArray(doc.entries)
	)
		return false;
	try {
		return Object.entries(doc.entries).every(([key, e]) => {
			if (
				!e ||
				!e.identity ||
				e.identity.project !== input.project ||
				e.identity.lead !== input.lead ||
				continuityDigest(e.identity) !== key ||
				continuityDigest(e.semanticState) !== e.semanticDigest ||
				!Array.isArray(e.refs) ||
				typeof e.sourcesComplete !== "boolean" ||
				typeof e.canAttributeRemote !== "boolean"
			)
				return false;
			if (
				!e.sourceCursors ||
				![e.sourceCursors.stageEventId, e.sourceCursors.workflowEventSeq].every(
					(n) => Number.isSafeInteger(n) && n >= 0,
				)
			)
				return false;
			if (
				![
					e.observedSinceMs,
					e.lastSuccessfulObservationAtMs,
					e.coverageSinceMs,
				].every((n) => Number.isSafeInteger(n) && n > 0 && n <= doc.sampledAtMs)
			)
				return false;
			if (
				![e.lastProgressObservedAtMs, e.lastStateChangeAtMs].every(
					(n) =>
						n === null ||
						(Number.isSafeInteger(n) &&
							n >= e.observedSinceMs &&
							n <= doc.sampledAtMs),
				)
			)
				return false;
			return e.refs.every(
				(r) =>
					r &&
					/^[a-f0-9]{40}$/i.test(r.headSha) &&
					typeof r.repoIdentity === "string" &&
					typeof r.fullRef === "string" &&
					r.fullRef.startsWith("refs/heads/") &&
					Number.isSafeInteger(r.observedAtMs) &&
					r.observedAtMs <= doc.sampledAtMs,
			);
		});
	} catch {
		return false;
	}
}
export async function sampleContinuity(
	input: SampleContinuityInput,
): Promise<ContinuityBatch> {
	const facts: Record<string, ContinuityResult> = Object.create(null);
	let sidecar: ContinuitySidecar = {
		version: 2,
		project: input.project,
		lead: input.lead,
		sampledAtMs: input.nowMs,
		entries: {},
	};
	function failed(reason: string): ContinuityBatch {
		for (const execution of input.executionIds) {
			const old = Object.values(sidecar.entries).find(
				(e) => e.identity.executionId === execution,
			);
			facts[execution] = {
				key: old
					? continuityDigest(old.identity)
					: continuityDigest({
							project: input.project,
							lead: input.lead,
							execution,
						}),
				activity: "UNKNOWN",
				reason,
				entry: old,
				last_change_epoch: Math.floor(
					Math.max(
						old?.observedSinceMs ?? 0,
						old?.lastStateChangeAtMs ?? 0,
						old?.lastProgressObservedAtMs ?? 0,
					) / 1000,
				),
				last_change_basis: "baseline",
				interval_start: Math.floor(input.nowMs / 1000),
				interval_end: Math.floor(input.nowMs / 1000),
				branch_activity: false,
			};
		}
		return { facts, published: false };
	}
	if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0)
		return failed("clock_invalid");
	try {
		mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
	} catch {
		return failed("sidecar_directory_unavailable");
	}
	let lost = false;
	const abort = new AbortController();
	const lock = await (input.acquireLock ?? acquireProcessLifetimeFileLock)(
		input.path.replace(/\.json$/, ".lock"),
		{
			readyTimeoutMs: 5000,
			onLost: () => {
				lost = true;
				abort.abort();
			},
		},
	);
	if (lock.status !== "acquired")
		return failed(
			lock.status === "conflict" ? "lock_conflict" : "lock_unavailable",
		);
	let temporary: string | undefined;
	try {
		if (existsSync(input.path)) {
			try {
				const raw: unknown = JSON.parse(readFileSync(input.path, "utf8"));
				if (!validSidecar(raw, input)) return failed("sidecar_invalid");
				sidecar = raw;
			} catch {
				return failed("sidecar_invalid");
			}
		}
		const previous: Record<string, ContinuityEntry> = Object.create(null);
		for (const entry of Object.values(sidecar.entries))
			previous[entry.identity.executionId] = entry;
		let observations: ContinuityObservation[];
		try {
			observations = await input.collect(previous, abort.signal);
		} catch {
			// Commit a coverage break, preserving last successful observations and refs.
			for (const entry of Object.values(sidecar.entries))
				if (input.executionIds.includes(entry.identity.executionId)) {
					entry.sourcesComplete = false;
					entry.coverageSinceMs = input.nowMs;
				}
			observations = [];
			failed("collection_failed");
		}
		if (lost) return failed("lock_lost");
		const seen = new Set<string>();
		for (const observation of observations) {
			const id = observation.identity.executionId;
			if (
				!input.executionIds.includes(id) ||
				seen.has(id) ||
				observation.identity.project !== input.project ||
				observation.identity.lead !== input.lead ||
				observation.sampledAtMs !== input.nowMs
			)
				return failed("observation_identity_mismatch");
			seen.add(id);
			const result = evaluateContinuity(previous[id], observation);
			facts[id] = result;
			if (!result.entry && previous[id]) {
				previous[id].sourcesComplete = false;
				previous[id].coverageSinceMs = input.nowMs;
			}
			if (result.entry) {
				for (const [key, entry] of Object.entries(sidecar.entries))
					if (entry.identity.executionId === id) delete sidecar.entries[key];
				sidecar.entries[result.key] = result.entry;
			}
		}
		for (const id of input.executionIds)
			if (!seen.has(id)) {
				const old = previous[id];
				if (old) {
					old.sourcesComplete = false;
					old.coverageSinceMs = input.nowMs;
				}
				facts[id] ??= {
					key: continuityDigest({ id }),
					activity: "UNKNOWN",
					reason: "observation_missing",
					entry: old,
					last_change_epoch: 0,
					last_change_basis: "baseline",
					interval_start: Math.floor(input.nowMs / 1000),
					interval_end: Math.floor(input.nowMs / 1000),
					branch_activity: false,
				};
			}
		if (input.inventoryComplete)
			for (const [key, e] of Object.entries(sidecar.entries))
				if (!input.executionIds.includes(e.identity.executionId))
					delete sidecar.entries[key];
		sidecar.sampledAtMs = input.nowMs;
		temporary = `${input.path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(sidecar)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		chmodSync(temporary, 0o600);
		if (lost) return failed("lock_lost");
		renameSync(temporary, input.path);
		temporary = undefined;
		return { facts, published: true };
	} catch {
		return failed("sidecar_write_failed");
	} finally {
		if (temporary)
			try {
				unlinkSync(temporary);
			} catch {}
		await lock.handle.close();
	}
}

/** The structural report gate plus integrity of immutable machine observations. */
export function validatePatrolReport(text: string): {
	valid: boolean;
	errors: string[];
} {
	const verdict = validateReportStructure(text);
	const activities = new Map<string, Record<string, string>>();
	for (const line of text.split(/\r?\n/))
		if (line.startsWith("ACTIVITY_EVIDENCE ")) {
			const fields = Object.fromEntries(
				line
					.split(/\s+/)
					.slice(1)
					.map((token) => {
						const at = token.indexOf("=");
						return [token.slice(0, at), token.slice(at + 1)];
					}),
			);
			activities.set(fields.id ?? "", fields);
		}
	for (const line of text.split(/\r?\n/))
		if (line.startsWith("ACTIVITY_RECORD ")) {
			try {
				const record = JSON.parse(line.slice(16));
				if (record.entry === null && record.activity === "UNKNOWN") continue;
				const e = record.entry as ContinuityEntry;
				const evidence = activities.get(record.id);
				if (
					!e ||
					!evidence ||
					continuityDigest(e.identity) !== record.id ||
					continuityDigest(e.refs) !== evidence.refs_sha256 ||
					!validSidecar(
						{
							version: 2,
							project: e.identity.project,
							lead: e.identity.lead,
							sampledAtMs: record.sampledAtMs,
							entries: { [record.id]: e },
						},
						{
							project: e.identity.project,
							lead: e.identity.lead,
							nowMs: record.sampledAtMs,
						},
					)
				)
					verdict.errors.push("activity_record_integrity");
				if (record.activity === "STALLED_60M") {
					const start = Math.max(
						e.observedSinceMs,
						e.coverageSinceMs,
						e.lastStateChangeAtMs ?? 0,
						e.lastProgressObservedAtMs ?? 0,
					);
					if (
						!e.sourcesComplete ||
						e.semanticState.effectiveWait ||
						record.sampledAtMs - start < 3600000 ||
						Math.floor(start / 1000) !== record.interval_start
					)
						verdict.errors.push("stalled_interval_integrity");
				}
			} catch {
				verdict.errors.push("activity_record_integrity");
			}
		}
	return { valid: verdict.errors.length === 0, errors: verdict.errors };
}
