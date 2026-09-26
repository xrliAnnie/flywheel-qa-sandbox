import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonString } from "flywheel-config";
import { canonicalizeWorktreePath } from "./worktree-paths.js";
import {
	buildTakeoverEventPayload,
	encodeRescuePointer,
	type PendingTakeoverRescue,
	serializeTakeoverManifest,
	sha256Hex,
	TAKEOVER_RESCUE_SCHEMA,
	type TakeoverCleanedEventPayload,
	type TakeoverNestedMove,
	type TakeoverRescueClass,
	type TakeoverRescueKind,
	type TakeoverRescueManifest,
	type TakeoverRescuePermit,
	type TakeoverRescueRecorder,
	type TakeoverRescueRef,
	takeoverRescueEventUid,
	verifyTakeoverManifestAgainstEvent,
} from "./worktree-takeover-rescue.js";

/**
 * FLY-2901: shared branch-B worktree takeover transaction.
 *
 * Runs entirely inside ONE repo-lock critical section (WorktreeManager wraps
 * it): exclude root-cure → pending-rescue re-entry → entry matrix
 * (registration × existence) → classification → fingerprints → preservation
 * (snapshot, rescue refs pushed and verified) → manifest → checked rescue
 * event → [destructive phase] → mirror → cleaned receipt. Any step that cannot
 * prove "zero loss" returns `refused` WITHOUT touching the worktree; nothing
 * pushed or recorded is ever rolled back.
 */

export type TakeoverStopReason =
	| "kill_switch"
	| "repo_lock_unavailable"
	| "exclude_unavailable"
	| "unregistered_branch_unique_commits"
	| "rescue_evidence_unrecorded"
	| `permit_denied:${"live_writer" | "zombie_writer" | "permit_indeterminate"}`
	| "registration_indeterminate"
	| "worktree_head_unreadable"
	| "unregistered_present"
	| "generation_unrecoverable"
	| "git_operation_in_progress"
	| "worktree_locked"
	| `quarantine_overflow:${string}`
	| "remote_probe_failed"
	| "remote_head_unreachable"
	| "remote_not_ancestor"
	| "rescue_ref_conflict"
	| "rescue_push_failed"
	| "rescue_push_unverified"
	| "zero_loss_invariant_violated"
	| "worktree_unstable"
	| "worktree_changed_during_rescue"
	| "rescue_event_capability_missing"
	| "rescue_event_unrecorded"
	| "rescue_resume_mismatch"
	| "nested_move_failed"
	| "ignored_content_at_risk"
	| "post_clean_dirty";

export interface TakeoverWorktree {
	projectName: string;
	issueId: string;
	worktreePath: string;
	branch: string;
	mainRepoPath: string;
	generation: string;
}

export interface TakeoverRescueEvidence {
	eventUid: string;
	manifest: TakeoverRescueManifest;
	manifestPath: string;
	manifestSha256: string;
	mirrorJsonPath: string;
	mirrorMdPath: string;
	/** Value for the successor's first `--pointer rescue=<value>`. */
	pointer: string;
	/** True when this call only finished a crash-interrupted earlier rescue. */
	resumed: boolean;
}

export type TakeoverTransactionResult =
	| { kind: "reused"; worktree: TakeoverWorktree }
	| { kind: "created"; worktree: TakeoverWorktree }
	| {
			kind: "rescued";
			worktree: TakeoverWorktree;
			evidence: TakeoverRescueEvidence;
	  }
	| {
			kind: "refused";
			reason: TakeoverStopReason;
			class?: TakeoverRescueClass;
			detail?: string;
			/** Porcelain paths (first 20) that made the tree non-reusable. */
			dirtyPaths: string[];
			dirtyPathsOverflow: number;
			/** Rescue refs already pushed + verified before the stop (kept). */
			completedRescues: TakeoverRescueRef[];
			head: string | null;
			clean: boolean | null;
			/** Kill switch: callers keep today's refusal copy/semantics. */
			legacy: boolean;
	  };

export type TakeoverStep =
	| "fingerprinted"
	| "pushed"
	| "manifest_written"
	| "event_recorded"
	| "nested_moved"
	| "reset_done"
	| "clean_done"
	| "pruned"
	| "created"
	| "mirror_written"
	| "cleaned_recorded";

export interface TakeoverTransactionInput {
	mainRepoPath: string;
	projectName: string;
	/** Worktree key (resolveWorktreeKey result) — derives path + branch. */
	issueId: string;
	/** Issue identifier used in rescue branch names. */
	issueKey: string;
	runId?: string;
	successorExec: string;
	startPoint: string;
	permit?: TakeoverRescuePermit;
	rescueDisabled: boolean;
	recorder?: TakeoverRescueRecorder;
	/** @internal deterministic boundary injection. */
	limits?: { maxFiles: number; maxBytes: number };
	/** @internal */
	stabilityWaitMs?: number;
	/** @internal */
	now?: () => Date;
	/** @internal crash injection: throwing aborts the transaction at `step`. */
	onStep?: (step: TakeoverStep) => void | Promise<void>;
}

type GitRun = (
	args: string[],
	cwd: string,
	opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<string>;

/** Narrow capability surface WorktreeManager hands the transaction. */
export interface TakeoverHost {
	/** git with RESUME_GIT_SAFE_CONFIG prepended. */
	git: GitRun;
	lockAvailable: boolean;
	expected(): { path: string; branch: string };
	listRegistered(): Promise<
		Array<{ path: string; branch: string | null; head: string | null }>
	>;
	readGeneration(worktreePath: string): Promise<string | undefined>;
	snapshot(opts: {
		worktreePath: string;
		head: string;
		status: string;
		limits: { maxFiles: number; maxBytes: number };
		identity: {
			userName: string;
			userEmail: string;
			stagedMessage: string;
			worktreeMessage: string;
		};
		skipUntracked?: ReadonlySet<string>;
	}): Promise<
		| { ok: true; stagedCommit: string; worktreeCommit: string }
		| { ok: false; reason: "quarantine_overflow"; detail: string }
	>;
	/** Re-entrant create (same repo lock). */
	create(opts: {
		startPoint: string;
		carryGeneration?: string;
	}): Promise<TakeoverWorktree>;
	/** Today's legacy cleanup (rm orphan / prune / branch -D) — lock held. */
	removeIfExistsUnlocked(): Promise<void>;
	ensureExcludes(cwd: string): Promise<void>;
	/** Root for manifests + nested moves: <state>/takeover-rescue. */
	rescueStateDir: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIRTY_PATH_LIMIT = 20;
const DEFAULT_LIMITS = { maxFiles: 2_000, maxBytes: 64 * 1024 * 1024 };
export const TAKEOVER_STABILITY_WAIT_MS = 5_000;
const PUSH_TIMEOUT_MS = 60_000;
const IN_PROGRESS_MARKERS = [
	"MERGE_HEAD",
	"rebase-merge",
	"rebase-apply",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"BISECT_LOG",
] as const;
const ABSENT_FINGERPRINT = sha256Hex("fly-2901:worktree-absent");

class Refusal extends Error {
	constructor(
		readonly reason: TakeoverStopReason,
		readonly detail?: string,
		readonly extra: {
			class?: TakeoverRescueClass;
			dirtyPaths?: string[];
			head?: string | null;
			clean?: boolean | null;
			legacy?: boolean;
		} = {},
	) {
		super(`${reason}${detail ? `:${detail}` : ""}`);
	}
}

type StatusEntry = { path: string; originalPath?: string; untracked: boolean };

/** Minimal porcelain=v2 -z path extraction (entry grammar owned by git). */
function statusPaths(status: string): StatusEntry[] {
	const fields = status.split("\0");
	const entries: StatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		if (field.startsWith("? ")) {
			entries.push({ path: field.slice(2), untracked: true });
		} else if (field.startsWith("1 ")) {
			const parts = field.split(" ");
			entries.push({ path: parts.slice(8).join(" "), untracked: false });
		} else if (field.startsWith("2 ")) {
			const parts = field.split(" ");
			const originalPath = fields[index + 1];
			index += 1;
			entries.push({
				path: parts.slice(9).join(" "),
				...(originalPath !== undefined && { originalPath }),
				untracked: false,
			});
		} else if (field.startsWith("u ")) {
			const parts = field.split(" ");
			entries.push({ path: parts.slice(10).join(" "), untracked: false });
		} else if (!field.startsWith("! ")) {
			throw new Refusal("worktree_head_unreadable", "status_record_unknown");
		}
	}
	return entries;
}

function hasUnmerged(status: string): boolean {
	return status.split("\0").some((field) => field.startsWith("u "));
}

function utcStamp(now: Date): string {
	return now
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[-:]/g, "");
}

function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function sanitizeRefComponent(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "") || "x";
}

export async function runTakeoverTransaction(
	host: TakeoverHost,
	input: TakeoverTransactionInput,
): Promise<TakeoverTransactionResult> {
	const tx = new TakeoverTransaction(host, input);
	try {
		return await tx.run();
	} catch (error) {
		if (error instanceof Refusal) return tx.refused(error);
		throw error;
	}
}

class TakeoverTransaction {
	private readonly expected: { path: string; branch: string };
	private readonly canonicalPath: string;
	private readonly startPoint: string;
	private readonly limits: { maxFiles: number; maxBytes: number };
	private readonly now: () => Date;
	private readonly completedRescues: TakeoverRescueRef[] = [];
	private dirtyPaths: string[] = [];
	private head: string | null = null;
	private clean: boolean | null = null;
	private klass: TakeoverRescueClass | undefined;

	constructor(
		private readonly host: TakeoverHost,
		private readonly input: TakeoverTransactionInput,
	) {
		this.expected = host.expected();
		this.canonicalPath = canonicalizeWorktreePath(this.expected.path);
		this.startPoint = input.startPoint.trim().toLowerCase();
		this.limits = input.limits ?? DEFAULT_LIMITS;
		this.now = input.now ?? (() => new Date());
	}

	refused(
		error: Refusal,
	): Extract<TakeoverTransactionResult, { kind: "refused" }> {
		const dirty = error.extra.dirtyPaths ?? this.dirtyPaths;
		return {
			kind: "refused",
			reason: error.reason,
			...((error.extra.class ?? this.klass) && {
				class: error.extra.class ?? this.klass,
			}),
			...(error.detail && { detail: error.detail }),
			dirtyPaths: dirty.slice(0, DIRTY_PATH_LIMIT),
			dirtyPathsOverflow: Math.max(0, dirty.length - DIRTY_PATH_LIMIT),
			completedRescues: [...this.completedRescues],
			head: error.extra.head ?? this.head,
			clean: error.extra.clean ?? this.clean,
			legacy: error.extra.legacy ?? false,
		};
	}

	private recorderReady(): TakeoverRescueRecorder | undefined {
		return this.input.recorder && this.input.runId
			? this.input.recorder
			: undefined;
	}

	private async step(step: TakeoverStep): Promise<void> {
		await this.input.onStep?.(step);
	}

	async run(): Promise<TakeoverTransactionResult> {
		if (!HEX40.test(this.startPoint)) {
			throw new Refusal("remote_not_ancestor", "invalid_start_point");
		}
		// §6 root cure first: pre-existing `.flywheel/review-targets/` nested
		// targets must be excluded BEFORE any status/cleanliness read.
		try {
			await this.host.ensureExcludes(this.input.mainRepoPath);
		} catch (error) {
			throw new Refusal(
				"exclude_unavailable",
				error instanceof Error ? error.message : String(error),
			);
		}
		// Codex R1 #2 / plan §4.0: without the Bridge-local recorder (or a run to
		// bind it to) a rescued-but-not-cleaned event on this path cannot be
		// seen, so NO classification result — not even today's reuse or fresh
		// create — may be returned; they could bypass a pending crash re-entry.
		const recorder = this.recorderReady();
		if (!recorder) throw new Refusal("rescue_event_capability_missing");
		{
			let pending: PendingTakeoverRescue[];
			try {
				pending = await recorder.loadPendingTakeoverRescue({
					runId: this.input.runId!,
					canonicalPath: this.canonicalPath,
				});
			} catch (error) {
				throw new Refusal(
					"rescue_event_capability_missing",
					`pending_lookup_failed:${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (pending.length > 1) {
				throw new Refusal("rescue_resume_mismatch", "multiple_pending");
			}
			if (pending.length === 1) return this.resumePending(pending[0]!);
		}

		let registered:
			| { path: string; branch: string | null; head: string | null }
			| undefined;
		try {
			registered = (await this.host.listRegistered()).find(
				(wt) => canonicalizeWorktreePath(wt.path) === this.canonicalPath,
			);
		} catch (error) {
			throw new Refusal(
				"registration_indeterminate",
				error instanceof Error ? error.message : String(error),
			);
		}
		const present = fs.existsSync(this.expected.path);
		if (!registered && present) {
			throw new Refusal("unregistered_present", undefined, {
				dirtyPaths: [this.expected.path],
			});
		}
		if (!registered) return this.unregisteredAbsent();
		if (!present) return this.worktreeMissing(registered);
		return this.registeredPresent();
	}

	// ─── Entry: registered + present ──────────────────────────────

	private async registeredPresent(): Promise<TakeoverTransactionResult> {
		const wt = this.expected.path;
		// Reuse keeps today's contract (no branch check); rescue requires the
		// worktree to sit on the expected branch.
		const head = await this.readWorktreeHead(wt, { requireBranch: false });
		this.head = head;
		const status = await this.readStatus(wt);
		const entries = statusPaths(status);
		this.clean = status.length === 0;
		this.dirtyPaths = entries.map((entry) => entry.path);
		const S = this.startPoint;
		const sInH = head === S || (await this.isAncestor(S, head));
		if (this.clean && sInH) {
			// Today's in-place reuse — byte-identical, no rescue flow.
			return {
				kind: "reused",
				worktree: this.worktreeInfo((await this.host.readGeneration(wt)) ?? ""),
			};
		}
		this.gateRescueAllowed({ legacyOnKillSwitch: true });
		await this.readWorktreeHead(wt);

		for (const marker of IN_PROGRESS_MARKERS) {
			const markerPath = await this.gitPath(wt, marker);
			if (fs.existsSync(markerPath)) {
				throw new Refusal("git_operation_in_progress", marker);
			}
		}
		if (fs.existsSync(await this.gitPath(wt, "locked"))) {
			throw new Refusal("worktree_locked");
		}
		if (hasUnmerged(status)) {
			throw new Refusal("quarantine_overflow:unrepresentable_index");
		}
		const nested = await this.detectNested(wt, entries);
		const nestedSet = new Set(nested.map((rel) => `${rel}/`));
		const R = await this.probeRemote();

		const hInS = await this.isAncestor(head, S);
		this.klass = sInH
			? nested.length > 0
				? "nested_repo"
				: "dirty"
			: hInS
				? "head_behind"
				: R !== null && head === R
					? "head_published_diverged"
					: "head_diverged";

		const candidates: string[] = [];
		if (sInH || (R !== null && head === R && !hInS)) candidates.push(head);
		candidates.push(S);
		const target = await this.pickTarget(candidates, R);
		await this.assertIgnoredContentSafe(wt, target);

		const f1 = await this.fingerprint(wt, nested, { head, status });
		await this.step("fingerprinted");
		await new Promise((resolve) =>
			setTimeout(
				resolve,
				this.input.stabilityWaitMs ?? TAKEOVER_STABILITY_WAIT_MS,
			),
		);
		const f2 = await this.fingerprint(wt, nested);
		if (f1 !== f2) throw new Refusal("worktree_unstable");

		const regularDirty = entries.some(
			(entry) => !(entry.untracked && nestedSet.has(entry.path)),
		);
		let snapshot: { stagedCommit: string; worktreeCommit: string } | null =
			null;
		let T = head;
		if (regularDirty) {
			const taken = await this.host.snapshot({
				worktreePath: wt,
				head,
				status,
				limits: this.limits,
				identity: {
					userName: "Flywheel Takeover Rescue",
					userEmail: "takeover-rescue@flywheel.local",
					stagedMessage: `FLY-2901 staged takeover rescue ${this.input.successorExec}`,
					worktreeMessage: `FLY-2901 worktree takeover rescue ${this.input.successorExec}`,
				},
				skipUntracked: nestedSet,
			});
			if (!taken.ok) {
				throw new Refusal(`quarantine_overflow:${taken.detail}`);
			}
			snapshot = {
				stagedCommit: taken.stagedCommit,
				worktreeCommit: taken.worktreeCommit,
			};
			T = taken.worktreeCommit;
		}

		const covered = (x: string) => this.equalsOrAncestor(x, target);
		const wanted: Array<{ kind: TakeoverRescueKind; tip: string }> = [];
		if (T !== head) wanted.push({ kind: "dirty", tip: T });
		else if (!(await covered(head))) wanted.push({ kind: "head", tip: head });
		if (!(await covered(S))) wanted.push({ kind: "base", tip: S });
		const stamp = utcStamp(this.now());
		const rescues = await this.pushRescues(wanted, stamp);
		await this.assertZeroLoss([head, T, S], target, R, rescues);

		const f3 = await this.fingerprint(wt, nested);
		if (f3 !== f2) throw new Refusal("worktree_changed_during_rescue");
		const stampDir = this.stampDir(stamp);
		const nestedMoves = await this.planNestedMoves(wt, nested, stampDir);
		const generationBefore = (await this.host.readGeneration(wt)) ?? null;
		const manifest = this.buildManifest({
			klass: this.klass,
			stamp,
			generationBefore,
			headBefore: head,
			target,
			remoteTip: R,
			rescues,
			snapshot,
			nestedMoves,
			fingerprints: { first: f1, second: f2, third: f3 },
			generationCarried: false,
		});
		const recorded = await this.persistRescue(manifest, stampDir, [head, T, S]);

		// ── destructive phase (event is durable) ──
		await this.destroyInPlace(wt, manifest);
		return this.finish(recorded, manifest, false);
	}

	// ─── Entry: registered + missing directory ────────────────────

	private async worktreeMissing(registered: {
		path: string;
		branch: string | null;
	}): Promise<TakeoverTransactionResult> {
		this.klass = "worktree_missing";
		const generation = await this.recoverMissingGeneration(registered);
		this.gateRescueAllowed({ legacyOnKillSwitch: true });
		const L = await this.localBranchTip();
		this.head = L;
		const S = this.startPoint;
		const R = await this.probeRemote();
		const candidates: string[] = [];
		if (
			L !== null &&
			(L === S || (await this.isAncestor(S, L)) || (R !== null && L === R))
		) {
			candidates.push(L);
		}
		candidates.push(S);
		const target = await this.pickTarget(candidates, R);
		const wanted: Array<{ kind: TakeoverRescueKind; tip: string }> = [];
		// R3 #1: create()'s rollback runs `branch -D`; keep L reachable from a
		// verified named ref on every failure path unless it IS the remote tip.
		if (L !== null && L !== R) wanted.push({ kind: "head", tip: L });
		if (!(await this.equalsOrAncestor(S, target))) {
			wanted.push({ kind: "base", tip: S });
		}
		const stamp = utcStamp(this.now());
		const rescues = await this.pushRescues(wanted, stamp);
		await this.assertZeroLoss(L !== null ? [L, S] : [S], target, R, rescues);
		const manifest = this.buildManifest({
			klass: "worktree_missing",
			stamp,
			generationBefore: generation,
			headBefore: L,
			target,
			remoteTip: R,
			rescues,
			snapshot: null,
			nestedMoves: [],
			fingerprints: {
				first: ABSENT_FINGERPRINT,
				second: ABSENT_FINGERPRINT,
				third: ABSENT_FINGERPRINT,
			},
			generationCarried: true,
		});
		const recorded = await this.persistRescue(
			manifest,
			this.stampDir(stamp),
			L !== null ? [L, S] : [S],
		);
		await this.rebuildMissing(manifest, true);
		return this.finish(recorded, manifest, false);
	}

	// ─── Entry: unregistered + absent ─────────────────────────────

	private async unregisteredAbsent(): Promise<TakeoverTransactionResult> {
		const L = await this.localBranchTip();
		const S = this.startPoint;
		if (L === null || (await this.equalsOrAncestor(L, S))) {
			// Today's fresh-create path, unchanged.
			await this.host.removeIfExistsUnlocked();
			return {
				kind: "created",
				worktree: await this.host.create({ startPoint: S }),
			};
		}
		this.klass = "unregistered_branch";
		this.head = L;
		try {
			this.gateRescueAllowed({ legacyOnKillSwitch: false });
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			throw new Refusal("unregistered_branch_unique_commits", error.message);
		}
		const stamp = utcStamp(this.now());
		let rescues: TakeoverRescueRef[];
		try {
			rescues = await this.pushRescues([{ kind: "head", tip: L }], stamp);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			throw new Refusal("unregistered_branch_unique_commits", error.message);
		}
		await this.assertZeroLoss([L, S], S, null, rescues);
		const manifest = this.buildManifest({
			klass: "unregistered_branch",
			stamp,
			generationBefore: null,
			headBefore: L,
			target: S,
			remoteTip: null,
			rescues,
			snapshot: null,
			nestedMoves: [],
			fingerprints: {
				first: ABSENT_FINGERPRINT,
				second: ABSENT_FINGERPRINT,
				third: ABSENT_FINGERPRINT,
			},
			generationCarried: false,
		});
		const recorded = await this.persistRescue(manifest, this.stampDir(stamp), [
			L,
			S,
		]);
		await this.host.removeIfExistsUnlocked();
		await this.host.create({ startPoint: S });
		await this.step("created");
		return this.finish(recorded, manifest, false);
	}

	// ─── Crash re-entry ───────────────────────────────────────────

	private async resumePending(
		pending: PendingTakeoverRescue,
	): Promise<TakeoverTransactionResult> {
		const payload = pending.payload;
		let bytes: Buffer;
		try {
			bytes = fs.readFileSync(payload.manifestPath);
		} catch {
			throw new Refusal("rescue_resume_mismatch", "manifest_unreadable");
		}
		const verified = verifyTakeoverManifestAgainstEvent(bytes, payload);
		if (!verified.ok) {
			throw new Refusal("rescue_resume_mismatch", verified.detail);
		}
		const manifest = verified.manifest;
		this.klass = manifest.class;
		if (
			manifest.canonicalPath !== this.canonicalPath ||
			manifest.branch !== this.expected.branch
		) {
			throw new Refusal("rescue_resume_mismatch", "path_or_branch");
		}
		const recorded = {
			eventUid: pending.eventUid,
			manifestPath: payload.manifestPath,
			manifestSha256: payload.manifestSha256,
		};
		let registered: boolean;
		try {
			registered = (await this.host.listRegistered()).some(
				(wt) => canonicalizeWorktreePath(wt.path) === this.canonicalPath,
			);
		} catch (error) {
			throw new Refusal(
				"registration_indeterminate",
				error instanceof Error ? error.message : String(error),
			);
		}
		const present = fs.existsSync(this.expected.path);
		if (registered && present && (await this.isSettled(manifest))) {
			return this.finish(recorded, manifest, true);
		}
		if (manifest.class === "worktree_missing" && !present) {
			this.gateRescueAllowed({ legacyOnKillSwitch: true });
			await this.rebuildMissing(manifest, registered);
			return this.finish(recorded, manifest, true);
		}
		if (manifest.class === "unregistered_branch" && !present && !registered) {
			this.gateRescueAllowed({ legacyOnKillSwitch: false });
			await this.host.removeIfExistsUnlocked();
			await this.host.create({ startPoint: manifest.target });
			await this.step("created");
			return this.finish(recorded, manifest, true);
		}
		const inPlace =
			manifest.class !== "worktree_missing" &&
			manifest.class !== "unregistered_branch";
		if (inPlace && registered && present) {
			const generation =
				(await this.host.readGeneration(this.expected.path)) ?? null;
			if (
				manifest.generationBefore !== null &&
				generation !== manifest.generationBefore
			) {
				throw new Refusal("rescue_resume_mismatch", "generation");
			}
			const nested = manifest.nestedMoves.map((move) => move.relPath);
			const now = await this.fingerprint(this.expected.path, nested).catch(
				() => undefined,
			);
			if (now === manifest.fingerprint3) {
				this.gateRescueAllowed({ legacyOnKillSwitch: true });
				await this.destroyInPlace(this.expected.path, manifest);
				return this.finish(recorded, manifest, true);
			}
		}
		throw new Refusal("rescue_resume_mismatch", "state_not_convergent");
	}

	/** Already at target and clean (and generation continuity where known). */
	private async isSettled(manifest: TakeoverRescueManifest): Promise<boolean> {
		const wt = this.expected.path;
		let head: string;
		let status: string;
		try {
			head = await this.readWorktreeHead(wt);
			status = await this.readStatus(wt);
		} catch {
			return false;
		}
		if (head !== manifest.target || status.length > 0) return false;
		for (const move of manifest.nestedMoves) {
			if (fs.existsSync(move.source) || !fs.existsSync(move.destination)) {
				return false;
			}
		}
		if (manifest.generationBefore === null) return true;
		return (
			((await this.host.readGeneration(wt)) ?? null) ===
			manifest.generationBefore
		);
	}

	// ─── Gates ────────────────────────────────────────────────────

	private gateRescueAllowed(opts: { legacyOnKillSwitch: boolean }): void {
		if (this.input.rescueDisabled) {
			throw new Refusal("kill_switch", undefined, {
				legacy: opts.legacyOnKillSwitch,
			});
		}
		const permit = this.input.permit;
		if (!permit?.allowed) {
			const denial =
				permit && permit.reason !== "no_live_writer"
					? permit.reason
					: "permit_indeterminate";
			throw new Refusal(`permit_denied:${denial}`);
		}
		if (!this.recorderReady()) {
			throw new Refusal("rescue_event_capability_missing");
		}
		if (!this.host.lockAvailable) {
			throw new Refusal("repo_lock_unavailable");
		}
	}

	// ─── Git probes ───────────────────────────────────────────────

	private async readWorktreeHead(
		wt: string,
		opts: { requireBranch: boolean } = { requireBranch: true },
	): Promise<string> {
		let head: string;
		let top: string;
		try {
			top = (
				await this.host.git(["-C", wt, "rev-parse", "--show-toplevel"], wt)
			).trim();
			head = (
				await this.host.git(["-C", wt, "rev-parse", "--verify", "HEAD"], wt)
			)
				.trim()
				.toLowerCase();
		} catch (error) {
			throw new Refusal(
				"worktree_head_unreadable",
				error instanceof Error ? error.message : String(error),
			);
		}
		if (canonicalizeWorktreePath(top) !== this.canonicalPath) {
			throw new Refusal("worktree_head_unreadable", "toplevel_mismatch");
		}
		if (!HEX40.test(head)) {
			throw new Refusal("worktree_head_unreadable", "head_not_sha1");
		}
		if (!opts.requireBranch) return head;
		let symbolic: string | undefined;
		try {
			symbolic = (
				await this.host.git(["-C", wt, "symbolic-ref", "-q", "HEAD"], wt)
			).trim();
		} catch {
			symbolic = undefined;
		}
		if (symbolic !== `refs/heads/${this.expected.branch}`) {
			throw new Refusal(
				"worktree_head_unreadable",
				`branch_mismatch:${symbolic ?? "detached"}`,
			);
		}
		return head;
	}

	private async readStatus(wt: string): Promise<string> {
		try {
			return await this.host.git(
				[
					"-C",
					wt,
					"--no-optional-locks",
					"status",
					"--porcelain=v2",
					"-z",
					"--untracked-files=all",
				],
				wt,
			);
		} catch (error) {
			throw new Refusal(
				"worktree_head_unreadable",
				`status_unreadable:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async gitPath(wt: string, name: string): Promise<string> {
		const out = (
			await this.host.git(
				["-C", wt, "rev-parse", "--path-format=absolute", "--git-path", name],
				wt,
			)
		).trim();
		return path.resolve(wt, out);
	}

	private async isAncestor(
		ancestor: string,
		descendant: string,
	): Promise<boolean> {
		if (ancestor === descendant) return true;
		try {
			await this.host.git(
				[
					"-C",
					this.input.mainRepoPath,
					"merge-base",
					"--is-ancestor",
					ancestor,
					descendant,
				],
				this.input.mainRepoPath,
			);
			return true;
		} catch {
			return false;
		}
	}

	private equalsOrAncestor(x: string, of: string): Promise<boolean> {
		return this.isAncestor(x, of);
	}

	/**
	 * Codex R1 #1: the local branch tip is three-state. Only a successful probe
	 * that lists no exact `refs/heads/<branch>` means "absent"; any command
	 * failure or malformed output is indeterminate and refuses BEFORE a prune,
	 * `branch -D`, or `worktree add -B` could drop the only name of its commits.
	 */
	private async localBranchTip(): Promise<string | null> {
		const ref = `refs/heads/${this.expected.branch}`;
		let listed: string;
		try {
			listed = await this.host.git(
				[
					"-C",
					this.input.mainRepoPath,
					"for-each-ref",
					"--format=%(refname) %(objectname)",
					ref,
				],
				this.input.mainRepoPath,
			);
		} catch (error) {
			throw new Refusal(
				"registration_indeterminate",
				`local_branch_probe:${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const line of listed.split("\n")) {
			const [name, oid] = line.trim().split(" ");
			if (name !== ref) continue;
			const tip = (oid ?? "").toLowerCase();
			if (!HEX40.test(tip)) {
				throw new Refusal(
					"registration_indeterminate",
					"local_branch_probe:malformed",
				);
			}
			return tip;
		}
		return null;
	}

	/** §4.3: advertised remote tip, fetched by OID; never a remote-tracking ref. */
	private async probeRemote(): Promise<string | null> {
		const main = this.input.mainRepoPath;
		let advertised: string;
		try {
			advertised = (
				await this.host.git(
					[
						"-C",
						main,
						"ls-remote",
						"--heads",
						"origin",
						`refs/heads/${this.expected.branch}`,
					],
					main,
				)
			).trim();
		} catch (error) {
			throw new Refusal(
				"remote_probe_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
		if (!advertised) return null;
		const R = advertised.split(/\s+/)[0]?.toLowerCase() ?? "";
		if (!HEX40.test(R)) throw new Refusal("remote_probe_failed", "bad_oid");
		try {
			await this.host.git(
				["-C", main, "cat-file", "-e", `${R}^{commit}`],
				main,
			);
		} catch {
			try {
				await this.host.git(
					["-C", main, "fetch", "--no-tags", "origin", R],
					main,
					{ timeoutMs: PUSH_TIMEOUT_MS },
				);
			} catch (error) {
				throw new Refusal(
					"remote_head_unreachable",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		return R;
	}

	private async pickTarget(
		candidates: string[],
		R: string | null,
	): Promise<string> {
		for (const candidate of candidates) {
			if (R === null || (await this.isAncestor(R, candidate))) return candidate;
		}
		throw new Refusal("remote_not_ancestor");
	}

	// ─── Nested repositories (§4.4) ───────────────────────────────

	private async detectNested(
		wt: string,
		entries: StatusEntry[],
	): Promise<string[]> {
		const nested: string[] = [];
		for (const entry of entries) {
			if (!entry.untracked || !entry.path.endsWith("/")) continue;
			const rel = entry.path.slice(0, -1);
			const abs = path.join(wt, rel);
			let top: string | undefined;
			try {
				top = (
					await this.host.git(["-C", abs, "rev-parse", "--show-toplevel"], abs)
				).trim();
			} catch {
				top = undefined;
			}
			if (!top || realpathOrSelf(top) !== realpathOrSelf(abs)) {
				throw new Refusal("quarantine_overflow:unsupported_file_type", rel);
			}
			nested.push(rel);
		}
		return nested.sort();
	}

	private async nestedIdentity(
		abs: string,
	): Promise<{ head: string | null; statusDigest: string }> {
		let head: string | null = null;
		try {
			head = (
				await this.host.git(["-C", abs, "rev-parse", "--verify", "HEAD"], abs)
			)
				.trim()
				.toLowerCase();
		} catch {
			head = null;
		}
		const status = await this.host.git(
			[
				"-C",
				abs,
				"--no-optional-locks",
				"status",
				"--porcelain=v2",
				"-z",
				"--untracked-files=all",
			],
			abs,
		);
		return { head, statusDigest: sha256Hex(status) };
	}

	private async planNestedMoves(
		wt: string,
		nested: string[],
		stampDir: string,
	): Promise<TakeoverNestedMove[]> {
		const moves: TakeoverNestedMove[] = [];
		for (const rel of nested) {
			const source = path.join(wt, rel);
			const destination = path.join(stampDir, "nested", rel);
			if (fs.existsSync(destination)) {
				throw new Refusal("nested_move_failed", `destination_exists:${rel}`);
			}
			const identity = await this.nestedIdentity(source).catch(() => {
				throw new Refusal("nested_move_failed", `identity_unreadable:${rel}`);
			});
			let mode: TakeoverNestedMove["mode"] = "rename";
			const dotGit = path.join(source, ".git");
			const dotGitStat = fs.lstatSync(dotGit, { throwIfNoEntry: false });
			if (dotGitStat?.isFile()) {
				const commonDir = (
					await this.host.git(
						[
							"-C",
							source,
							"rev-parse",
							"--path-format=absolute",
							"--git-common-dir",
						],
						source,
					)
				).trim();
				const listed = await this.host.git(
					[`--git-dir=${commonDir}`, "worktree", "list", "--porcelain"],
					source,
				);
				const linked = listed
					.split("\n")
					.filter((line) => line.startsWith("worktree "))
					.map((line) => realpathOrSelf(line.slice("worktree ".length)))
					.slice(1);
				if (linked.includes(realpathOrSelf(source))) {
					mode = "worktree_move";
					const adminDir = (
						await this.host.git(
							[
								"-C",
								source,
								"rev-parse",
								"--path-format=absolute",
								"--git-dir",
							],
							source,
						)
					).trim();
					if (fs.existsSync(path.join(adminDir, "locked"))) {
						throw new Refusal("nested_move_failed", `worktree_locked:${rel}`);
					}
				} else {
					const gitfile = fs.readFileSync(dotGit, "utf8").trim();
					const gitdir = gitfile.replace(/^gitdir:\s*/, "");
					if (!path.isAbsolute(gitdir)) {
						throw new Refusal("nested_move_failed", `relative_gitfile:${rel}`);
					}
				}
			} else if (dotGitStat?.isDirectory()) {
				const listed = await this.host.git(
					["-C", source, "worktree", "list", "--porcelain"],
					source,
				);
				const count = listed
					.split("\n")
					.filter((line) => line.startsWith("worktree ")).length;
				if (count > 1) {
					throw new Refusal(
						"nested_move_failed",
						`repo_has_linked_worktrees:${rel}`,
					);
				}
			} else {
				throw new Refusal("nested_move_failed", `no_git_dir:${rel}`);
			}
			const stateDev = fs.statSync(this.nearestExisting(stampDir)).dev;
			if (fs.statSync(source).dev !== stateDev) {
				throw new Refusal("nested_move_failed", `cross_device:${rel}`);
			}
			moves.push({
				relPath: rel,
				source,
				destination,
				mode,
				head: identity.head,
				statusDigest: identity.statusDigest,
			});
		}
		return moves;
	}

	private nearestExisting(dir: string): string {
		let current = dir;
		while (!fs.existsSync(current)) {
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return current;
	}

	private async moveNested(move: TakeoverNestedMove): Promise<void> {
		if (!fs.existsSync(move.source) && fs.existsSync(move.destination)) {
			return; // crash re-entry: this one already moved
		}
		if (fs.existsSync(move.destination)) {
			throw new Refusal(
				"nested_move_failed",
				`destination_exists:${move.relPath}`,
			);
		}
		fs.mkdirSync(path.dirname(move.destination), {
			recursive: true,
			mode: 0o700,
		});
		try {
			if (move.mode === "worktree_move") {
				const commonDir = (
					await this.host.git(
						[
							"-C",
							move.source,
							"rev-parse",
							"--path-format=absolute",
							"--git-common-dir",
						],
						move.source,
					)
				).trim();
				await this.host.git(
					[
						`--git-dir=${commonDir}`,
						"worktree",
						"move",
						move.source,
						move.destination,
					],
					path.dirname(move.destination),
				);
			} else {
				fs.renameSync(move.source, move.destination);
			}
		} catch (error) {
			throw new Refusal(
				"nested_move_failed",
				`${move.relPath}:${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const after = await this.nestedIdentity(move.destination).catch(
			() => undefined,
		);
		if (
			!after ||
			after.head !== move.head ||
			after.statusDigest !== move.statusDigest
		) {
			throw new Refusal("nested_move_failed", `verify:${move.relPath}`);
		}
		await this.step("nested_moved");
	}

	// ─── Fingerprint (§4.2) ───────────────────────────────────────

	private async fingerprint(
		wt: string,
		nested: string[],
		baseline?: { head: string; status: string },
	): Promise<string> {
		const head = await this.readWorktreeHead(wt);
		const status = await this.readStatus(wt);
		// Classification and snapshot share this baseline. A write during the
		// remote/ignore probes must not fall outside their path list while all
		// three later fingerprints agree on the newer state.
		if (baseline && (head !== baseline.head || status !== baseline.status)) {
			throw new Refusal("worktree_unstable", "classification_state_changed");
		}
		let indexTree: string;
		try {
			indexTree = (await this.host.git(["-C", wt, "write-tree"], wt)).trim();
		} catch {
			indexTree = "unwritable";
		}
		const nestedDirs = new Set(nested.map((rel) => `${rel}/`));
		const paths = new Set<string>();
		for (const entry of statusPaths(status)) {
			if (entry.untracked && nestedDirs.has(entry.path)) continue;
			paths.add(entry.path);
			if (entry.originalPath) paths.add(entry.originalPath);
		}
		const contents = [...paths].sort().map((rel) => {
			const abs = path.join(wt, rel);
			const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
			if (!stat) return `${rel}\0deleted`;
			if (stat.isSymbolicLink()) return `${rel}\0link:${fs.readlinkSync(abs)}`;
			if (stat.isFile()) {
				return `${rel}\0file:${stat.mode & 0o111 ? "x" : "-"}:${createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`;
			}
			return `${rel}\0dir`;
		});
		const nestedIds = [];
		for (const rel of [...nested].sort()) {
			const id = await this.nestedIdentity(path.join(wt, rel));
			nestedIds.push({ rel, ...id });
		}
		return sha256Hex(
			canonicalJsonString({
				head,
				indexTree,
				status: sha256Hex(status),
				contents,
				nested: nestedIds,
			}),
		);
	}

	// ─── Preservation ─────────────────────────────────────────────

	private rescueNames(
		kind: TakeoverRescueKind,
		stamp: string,
	): { localRef: string; remoteBranch: string } {
		const pred =
			[...(this.input.permit?.predecessors ?? [])]
				.map((predecessor) => predecessor.executionId)
				.sort()[0] ?? "none";
		const succ = this.input.successorExec;
		const run = this.input.runId ?? "norun";
		return {
			localRef: `refs/flywheel/rescue/${sanitizeRefComponent(run)}/${sanitizeRefComponent(pred)}/${sanitizeRefComponent(succ)}/${stamp}/${kind}`,
			remoteBranch: `flywheel-rescue/${sanitizeRefComponent(this.input.issueKey)}/${sanitizeRefComponent(pred.slice(0, 8))}-${sanitizeRefComponent(succ.slice(0, 8))}-${stamp}-${kind}`,
		};
	}

	private async pushRescues(
		wanted: Array<{ kind: TakeoverRescueKind; tip: string }>,
		stamp: string,
	): Promise<TakeoverRescueRef[]> {
		if (wanted.length === 0) return [];
		const main = this.input.mainRepoPath;
		const refs: TakeoverRescueRef[] = wanted.map(({ kind, tip }) => ({
			kind,
			tip,
			...this.rescueNames(kind, stamp),
		}));
		for (const ref of refs) {
			try {
				await this.host.git(
					["-C", main, "check-ref-format", ref.localRef],
					main,
				);
				await this.host.git(
					["-C", main, "check-ref-format", `refs/heads/${ref.remoteBranch}`],
					main,
				);
			} catch {
				throw new Refusal("rescue_ref_conflict", `invalid_ref:${ref.kind}`);
			}
			let existing: string | undefined;
			try {
				existing = (
					await this.host.git(
						["-C", main, "rev-parse", "--verify", "--quiet", ref.localRef],
						main,
					)
				)
					.trim()
					.toLowerCase();
			} catch {
				existing = undefined;
			}
			if (existing && existing !== ref.tip) {
				throw new Refusal("rescue_ref_conflict", ref.localRef);
			}
			if (!existing) {
				try {
					await this.host.git(
						["-C", main, "update-ref", ref.localRef, ref.tip, "0".repeat(40)],
						main,
					);
				} catch {
					throw new Refusal("rescue_ref_conflict", ref.localRef);
				}
			}
		}
		const advertisedBefore = await this.lsRemote(refs).catch((error) => {
			throw new Refusal(
				"rescue_push_failed",
				`preflight:${error instanceof Error ? error.message : String(error)}`,
			);
		});
		const toPush = refs.filter((ref) => {
			const current = advertisedBefore.get(ref.remoteBranch);
			if (current === undefined) return true;
			if (current === ref.tip) return false;
			throw new Refusal("rescue_ref_conflict", ref.remoteBranch);
		});
		if (toPush.length > 0) {
			try {
				await this.host.git(
					[
						"-C",
						main,
						"push",
						"--atomic",
						// Codex R1 #3: an empty lease means "this ref must not exist" —
						// the push stays create-only even if another host races the
						// ls-remote preflight with an ancestor-valued ref.
						...toPush.map(
							(ref) => `--force-with-lease=refs/heads/${ref.remoteBranch}:`,
						),
						"origin",
						...toPush.map((ref) => `${ref.tip}:refs/heads/${ref.remoteBranch}`),
					],
					main,
					{ timeoutMs: PUSH_TIMEOUT_MS },
				);
			} catch (error) {
				throw new Refusal(
					"rescue_push_failed",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		let advertised: Map<string, string>;
		try {
			advertised = await this.lsRemote(refs);
		} catch (error) {
			throw new Refusal(
				"rescue_push_unverified",
				error instanceof Error ? error.message : String(error),
			);
		}
		for (const ref of refs) {
			if (advertised.get(ref.remoteBranch) !== ref.tip) {
				throw new Refusal("rescue_push_unverified", ref.remoteBranch);
			}
			this.completedRescues.push(ref);
		}
		await this.step("pushed");
		return refs;
	}

	private async lsRemote(
		refs: TakeoverRescueRef[],
	): Promise<Map<string, string>> {
		const main = this.input.mainRepoPath;
		const out = await this.host.git(
			[
				"-C",
				main,
				"ls-remote",
				"origin",
				...refs.map((ref) => `refs/heads/${ref.remoteBranch}`),
			],
			main,
			{ timeoutMs: PUSH_TIMEOUT_MS },
		);
		const map = new Map<string, string>();
		for (const line of out.split("\n")) {
			const [oid, ref] = line.trim().split(/\s+/);
			if (!oid || !ref?.startsWith("refs/heads/")) continue;
			map.set(ref.slice("refs/heads/".length), oid.toLowerCase());
		}
		return map;
	}

	/** §2.2 zero-loss invariant — a code assertion, never a heuristic. */
	private async assertZeroLoss(
		tips: string[],
		target: string,
		R: string | null,
		rescues: TakeoverRescueRef[],
	): Promise<void> {
		for (const tip of new Set(tips)) {
			if (await this.isAncestor(tip, target)) continue;
			let rescued = false;
			for (const rescue of rescues) {
				if (await this.isAncestor(tip, rescue.tip)) {
					rescued = true;
					break;
				}
			}
			if (!rescued) {
				throw new Refusal("zero_loss_invariant_violated", tip);
			}
		}
		if (R !== null && !(await this.isAncestor(R, target))) {
			throw new Refusal("zero_loss_invariant_violated", `remote:${R}`);
		}
	}

	// ─── Manifest + events (§4.5) ─────────────────────────────────

	private stampDir(stamp: string): string {
		const run = this.input.runId ?? "";
		const succ = this.input.successorExec;
		if (!SAFE_COMPONENT.test(run) || !SAFE_COMPONENT.test(succ)) {
			throw new Refusal("rescue_evidence_unrecorded", "unsafe_identity");
		}
		return path.join(this.host.rescueStateDir, run, succ, stamp);
	}

	private buildManifest(fields: {
		klass: TakeoverRescueClass;
		stamp: string;
		generationBefore: string | null;
		headBefore: string | null;
		target: string;
		remoteTip: string | null;
		rescues: TakeoverRescueRef[];
		snapshot: { stagedCommit: string; worktreeCommit: string } | null;
		nestedMoves: TakeoverNestedMove[];
		fingerprints: { first: string; second: string; third: string };
		generationCarried: boolean;
	}): TakeoverRescueManifest {
		return {
			schema: TAKEOVER_RESCUE_SCHEMA,
			runId: this.input.runId ?? "",
			issueKey: this.input.issueKey,
			successorExec: this.input.successorExec,
			predecessors: [...(this.input.permit?.predecessors ?? [])].sort(
				(left, right) =>
					left.executionId < right.executionId
						? -1
						: left.executionId > right.executionId
							? 1
							: 0,
			),
			canonicalPath: this.canonicalPath,
			branch: this.expected.branch,
			generationBefore: fields.generationBefore,
			class: fields.klass,
			startPoint: this.startPoint,
			headBefore: fields.headBefore,
			target: fields.target,
			remoteTip: fields.remoteTip,
			rescues: fields.rescues,
			snapshot: fields.snapshot,
			nestedMoves: fields.nestedMoves,
			fingerprint3: fields.fingerprints.third,
			fingerprints: fields.fingerprints,
			generationCarried: fields.generationCarried,
			stamp: fields.stamp,
			at: this.now().toISOString(),
		};
	}

	private async persistRescue(
		manifest: TakeoverRescueManifest,
		stampDir: string,
		tips: string[],
	): Promise<{
		eventUid: string;
		manifestPath: string;
		manifestSha256: string;
	}> {
		const manifestPath = path.join(stampDir, "manifest.json");
		const bytes = serializeTakeoverManifest(manifest);
		const manifestSha256 = sha256Hex(bytes);
		try {
			fs.mkdirSync(stampDir, { recursive: true, mode: 0o700 });
			if (fs.existsSync(manifestPath)) throw new Error("manifest_exists");
			const temp = path.join(
				stampDir,
				`.manifest.${process.pid}.${Date.now()}.tmp`,
			);
			fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
			fs.renameSync(temp, manifestPath);
			if (sha256Hex(fs.readFileSync(manifestPath)) !== manifestSha256) {
				throw new Error("manifest_readback_mismatch");
			}
		} catch (error) {
			throw new Refusal(
				"rescue_evidence_unrecorded",
				error instanceof Error ? error.message : String(error),
			);
		}
		await this.step("manifest_written");
		const eventUid = takeoverRescueEventUid({
			runId: manifest.runId,
			successorExec: manifest.successorExec,
			tips: [...tips, ...manifest.rescues.map((rescue) => rescue.tip)],
			target: manifest.target,
		});
		try {
			await this.recorderReady()!.recordRescue({
				runId: manifest.runId,
				eventUid,
				payload: buildTakeoverEventPayload(
					manifest,
					manifestPath,
					manifestSha256,
				),
			});
		} catch (error) {
			throw new Refusal(
				"rescue_event_unrecorded",
				error instanceof Error ? error.message : String(error),
			);
		}
		await this.step("event_recorded");
		return { eventUid, manifestPath, manifestSha256 };
	}

	// ─── Destructive phase ────────────────────────────────────────

	/** v5.2 §4.7a: ignored bytes are absent from snapshots and fingerprints. */
	private async assertIgnoredContentSafe(
		wt: string,
		target: string,
	): Promise<void> {
		type Rule = "a" | "b" | "c" | "d" | "e" | "f";
		const risks: Array<{ rule: Rule; path: string }> = [];
		const fail = (rule: Rule, name: string, error: unknown): never => {
			throw new Refusal(
				"ignored_content_at_risk",
				`(${rule}) ${JSON.stringify(name)}: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
			);
		};
		const exitOne = (error: unknown): boolean => {
			const e = error as {
				code?: unknown;
				status?: unknown;
				signal?: unknown;
				killed?: boolean;
				timedOut?: boolean;
			} | null;
			return (
				e !== null &&
				typeof e === "object" &&
				(e.code === 1 || e.status === 1) &&
				!e.signal &&
				!e.killed &&
				!e.timedOut
			);
		};
		const probe = async (
			args: string[],
			rule: Rule,
			allowAbsent = false,
		): Promise<string | null> => {
			try {
				return await this.host.git(["-C", wt, ...args], wt);
			} catch (error) {
				if (allowAbsent && exitOne(error)) return null;
				return fail(rule, args.join(" "), error);
			}
		};
		const nul = (out: string, rule: Rule, name: string): string[] => {
			if (out === "") return [];
			if (!out.endsWith("\0"))
				return fail(rule, name, "missing NUL terminator");
			const records = out.slice(0, -1).split("\0");
			if (records.some((record) => record === ""))
				return fail(rule, name, "empty record");
			return records;
		};
		const config = async (
			key: string,
			kind: "--bool" | "--path",
		): Promise<string | null> => {
			const out = await probe(
				["config", "--null", kind, "--get", key],
				"e",
				true,
			);
			if (out === null) return null;
			// --null preserves spaces and newlines in configured filenames.
			const values = nul(out, "e", `config ${key}`);
			if (values.length !== 1)
				return fail("e", `config ${key}`, "expected one value");
			return values[0]!;
		};
		const ignoreCaseValue = await config("core.ignorecase", "--bool");
		if (
			ignoreCaseValue !== null &&
			ignoreCaseValue !== "true" &&
			ignoreCaseValue !== "false"
		) {
			fail("e", "config core.ignorecase", "invalid boolean");
		}
		const fold = (name: string) =>
			ignoreCaseValue === "true" ? name.toLowerCase() : name;
		const validPath = (name: string, rule: Rule, command: string): string => {
			if (
				path.isAbsolute(name) ||
				name.split("/").some((part) => !part || part === "." || part === "..")
			) {
				fail(
					rule,
					command,
					`invalid index/worktree path ${JSON.stringify(name)}`,
				);
			}
			return name;
		};
		const index = new Set<string>();
		for (const entry of nul(
			(await probe(["ls-files", "-z", "--cached", "-v"], "f"))!,
			"f",
			"ls-files",
		)) {
			if (!/^[HSMRCK?hsmrck] /.test(entry))
				fail("f", "ls-files", "invalid index tag");
			const name = validPath(entry.slice(2), "f", "ls-files");
			// Cached-index membership is exact even with core.ignorecase=true.
			index.add(name);
			if (/^[a-zS]/.test(entry)) risks.push({ rule: "f", path: name });
		}
		const stat = (name: string, rule: Rule): fs.Stats | null => {
			try {
				return fs.lstatSync(path.join(wt, name));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") return null;
				return fail(rule, name, error);
			}
		};
		// Compare the target to the current index/worktree even when target == H.
		const diff = nul(
			(await probe(
				["diff", "--name-only", "-z", "--no-renames", target],
				"a",
			))!,
			"a",
			"diff",
		);
		for (const record of diff) {
			const name = validPath(record, "a", "diff");
			const info = stat(name, "a");
			if (info?.isDirectory()) risks.push({ rule: "a", path: name });
			if (
				!index.has(name) &&
				info &&
				(await probe(
					["check-ignore", "--no-index", "-q", "--", name],
					"b",
					true,
				)) !== null
			) {
				risks.push({ rule: "b", path: name });
			}
			for (
				let parent = path.posix.dirname(name);
				parent !== ".";
				parent = path.posix.dirname(parent)
			) {
				const ancestor = stat(parent, "c");
				if (ancestor && !ancestor.isDirectory() && !index.has(parent))
					risks.push({ rule: "c", path: parent });
			}
			if (path.posix.basename(name).toLowerCase() === ".gitignore")
				risks.push({ rule: "d", path: name });
		}

		const configured = await config("core.excludesFile", "--path");
		const configHome =
			process.env.XDG_CONFIG_HOME ||
			(process.env.HOME ? `${process.env.HOME}/.config` : null);
		if (configured === null && configHome === null)
			fail("e", "global excludes", "default config home unavailable");
		const excludes = configured ?? `${configHome}/git/ignore`;
		// Do not path.resolve the whole name before walking: `link/..` must
		// traverse the link before .. is applied, including intermediate visits.
		const absolute = path.isAbsolute(excludes) ? excludes : `${wt}/${excludes}`;
		let realRoot: string;
		try {
			realRoot = fs.realpathSync(wt);
		} catch (error) {
			return fail("e", wt, error);
		}
		const roots = [wt, realRoot].map((root) => fold(path.resolve(root)));
		const crossesWorktree = (name: string): boolean => {
			const candidate = fold(path.resolve(name));
			if (
				!roots.some(
					(root) =>
						candidate === root || candidate.startsWith(`${root}${path.sep}`),
				)
			)
				return false;
			risks.push({ rule: "e", path: name });
			return true;
		};
		const walkExcludes = () => {
			if (crossesWorktree(absolute)) return;
			let current = path.parse(absolute).root;
			let remaining = absolute.slice(current.length).split(path.sep);
			let hops = 0;
			while (remaining.length > 0) {
				const component = remaining.shift()!;
				if (!component || component === ".") continue;
				if (component === "..") {
					current = path.dirname(current);
					if (crossesWorktree(current)) return;
					continue;
				}
				const next = path.join(current, component);
				if (crossesWorktree(next)) return;
				let info: fs.Stats;
				try {
					info = fs.lstatSync(next);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						current = next;
						continue;
					}
					return fail("e", next, error);
				}
				if (!info.isSymbolicLink()) {
					if (!info.isDirectory() && remaining.length > 0) {
						return fail("e", next, "non-directory intermediate component");
					}
					current = next;
					continue;
				}
				if (++hops > 40) return fail("e", next, "symlink hop limit exceeded");
				let link: string;
				try {
					link = fs.readlinkSync(next);
				} catch (error) {
					return fail("e", next, error);
				}
				const destination = path.isAbsolute(link) ? link : `${current}/${link}`;
				if (crossesWorktree(destination)) return;
				if (path.isAbsolute(link)) current = path.parse(link).root;
				remaining = [...link.split(path.sep), ...remaining];
			}
		};
		walkExcludes();
		if (risks.length > 0) {
			const unique = [
				...new Map(
					risks.map((risk) => [`${risk.rule}\0${risk.path}`, risk]),
				).values(),
			];
			const listed = unique
				.slice(0, DIRTY_PATH_LIMIT)
				.map((risk) => `(${risk.rule}) ${JSON.stringify(risk.path)}`)
				.join("; ");
			const overflow = unique.length - DIRTY_PATH_LIMIT;
			throw new Refusal(
				"ignored_content_at_risk",
				`${listed}${overflow > 0 ? ` …(+${overflow} more)` : ""}`,
				{
					dirtyPaths: unique.map((risk) => `(${risk.rule}) ${risk.path}`),
				},
			);
		}
	}

	private async destroyInPlace(
		wt: string,
		manifest: TakeoverRescueManifest,
	): Promise<void> {
		await this.assertIgnoredContentSafe(wt, manifest.target);
		for (const move of manifest.nestedMoves) await this.moveNested(move);
		const destructive = async (args: string[]) => {
			try {
				await this.host.git(["-C", wt, ...args], wt);
			} catch (error) {
				throw new Refusal(
					"post_clean_dirty",
					error instanceof Error ? error.message : String(error),
				);
			}
		};
		await destructive(["reset", "--hard", manifest.target]);
		await this.step("reset_done");
		await destructive(["clean", "-fd"]);
		await this.step("clean_done");
		const head = await this.readWorktreeHead(wt);
		const status = await this.readStatus(wt);
		if (head !== manifest.target || status.length > 0) {
			this.dirtyPaths = statusPaths(status).map((entry) => entry.path);
			throw new Refusal("post_clean_dirty");
		}
	}

	private async rebuildMissing(
		manifest: TakeoverRescueManifest,
		stillRegistered: boolean,
	): Promise<void> {
		const main = this.input.mainRepoPath;
		if (stillRegistered) {
			await this.host.git(["-C", main, "worktree", "prune"], main);
			await this.step("pruned");
		}
		const generation = manifest.generationBefore;
		if (!generation) {
			throw new Refusal("generation_unrecoverable", "manifest_generation_null");
		}
		const created = await this.host.create({
			startPoint: manifest.target,
			carryGeneration: generation,
		});
		await this.step("created");
		if (created.generation !== generation) {
			throw new Refusal("post_clean_dirty", "generation_not_carried");
		}
		const head = await this.readWorktreeHead(created.worktreePath);
		if (head !== manifest.target) {
			throw new Refusal("post_clean_dirty", "rebuilt_head_mismatch");
		}
	}

	private async recoverMissingGeneration(registered: {
		path: string;
		branch: string | null;
	}): Promise<string> {
		const main = this.input.mainRepoPath;
		if (registered.branch !== this.expected.branch) {
			throw new Refusal(
				"generation_unrecoverable",
				`branch_mismatch:${registered.branch ?? "detached"}`,
			);
		}
		let commonDir: string;
		try {
			commonDir = (
				await this.host.git(
					[
						"-C",
						main,
						"rev-parse",
						"--path-format=absolute",
						"--git-common-dir",
					],
					main,
				)
			).trim();
		} catch {
			throw new Refusal("generation_unrecoverable", "common_dir");
		}
		const adminRoot = path.join(commonDir, "worktrees");
		let adminDir: string | undefined;
		let matches = 0;
		for (const name of fs.existsSync(adminRoot)
			? fs.readdirSync(adminRoot)
			: []) {
			const candidate = path.join(adminRoot, name);
			let gitdir: string;
			try {
				gitdir = fs.readFileSync(path.join(candidate, "gitdir"), "utf8").trim();
			} catch {
				continue;
			}
			const worktreeRoot = path.dirname(path.resolve(candidate, gitdir));
			if (canonicalizeWorktreePath(worktreeRoot) === this.canonicalPath) {
				adminDir = candidate;
				matches += 1;
			}
		}
		if (!adminDir || matches !== 1) {
			throw new Refusal("generation_unrecoverable", `admin_matches:${matches}`);
		}
		let headRef: string;
		let generation: string;
		try {
			headRef = fs.readFileSync(path.join(adminDir, "HEAD"), "utf8").trim();
			generation = fs
				.readFileSync(path.join(adminDir, "flywheel.generation"), "utf8")
				.trim();
		} catch {
			throw new Refusal("generation_unrecoverable", "admin_unreadable");
		}
		if (headRef !== `ref: refs/heads/${this.expected.branch}`) {
			throw new Refusal("generation_unrecoverable", "admin_head_mismatch");
		}
		if (!generation || /\s/.test(generation)) {
			throw new Refusal("generation_unrecoverable", "generation_missing");
		}
		return generation;
	}

	// ─── Evidence mirror + cleaned receipt ────────────────────────

	private async finish(
		recorded: {
			eventUid: string;
			manifestPath: string;
			manifestSha256: string;
		},
		manifest: TakeoverRescueManifest,
		resumed: boolean,
	): Promise<TakeoverTransactionResult> {
		const wt = this.expected.path;
		const generation = (await this.host.readGeneration(wt)) ?? "";
		const pointer = encodeRescuePointer(recorded.eventUid, manifest.rescues);
		const mirrorDir = path.join(wt, ".flywheel", "runs", "takeover");
		const mirrorJsonPath = path.join(
			mirrorDir,
			`${this.input.successorExec}.json`,
		);
		const mirrorMdPath = path.join(mirrorDir, `${this.input.successorExec}.md`);
		try {
			fs.mkdirSync(mirrorDir, { recursive: true });
			fs.writeFileSync(
				mirrorJsonPath,
				`${JSON.stringify(
					{
						eventUid: recorded.eventUid,
						manifestPath: recorded.manifestPath,
						manifestSha256: recorded.manifestSha256,
						pointer,
						manifest,
					},
					null,
					2,
				)}\n`,
			);
			fs.writeFileSync(
				mirrorMdPath,
				renderTakeoverRescueMarkdown(manifest, recorded.eventUid, pointer),
			);
		} catch (error) {
			throw new Refusal(
				"rescue_evidence_unrecorded",
				`mirror:${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await this.step("mirror_written");
		const cleaned: TakeoverCleanedEventPayload = {
			schema: TAKEOVER_RESCUE_SCHEMA,
			rescueEventUid: recorded.eventUid,
			manifestSha256: recorded.manifestSha256,
			canonicalPath: this.canonicalPath,
			target: manifest.target,
			generationAfter: generation || null,
			completedBy: this.input.successorExec,
		};
		try {
			await this.recorderReady()!.recordCleaned({
				runId: manifest.runId,
				rescueEventUid: recorded.eventUid,
				payload: cleaned,
			});
		} catch (error) {
			throw new Refusal(
				"rescue_event_unrecorded",
				`cleaned:${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await this.step("cleaned_recorded");
		return {
			kind: "rescued",
			worktree: this.worktreeInfo(generation),
			evidence: {
				eventUid: recorded.eventUid,
				manifest,
				manifestPath: recorded.manifestPath,
				manifestSha256: recorded.manifestSha256,
				mirrorJsonPath,
				mirrorMdPath,
				pointer,
				resumed,
			},
		};
	}

	private worktreeInfo(generation: string): TakeoverWorktree {
		return {
			projectName: this.input.projectName,
			issueId: this.input.issueId,
			worktreePath: this.expected.path,
			branch: this.expected.branch,
			mainRepoPath: this.input.mainRepoPath,
			generation,
		};
	}
}

/** Human-readable mirror / prompt body (paths shell-quoted in commands). */
export function renderTakeoverRescueMarkdown(
	manifest: TakeoverRescueManifest,
	eventUid: string,
	pointer: string,
): string {
	const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
	const lines = [
		"# Worktree takeover rescue",
		"",
		`- event: \`${eventUid}\``,
		`- class: \`${manifest.class}\``,
		`- startPoint: \`${manifest.startPoint}\``,
		`- headBefore: \`${manifest.headBefore ?? "none"}\``,
		`- target (current HEAD): \`${manifest.target}\``,
		`- remote branch tip at takeover: \`${manifest.remoteTip ?? "none"}\``,
		`- generation carried: ${manifest.generationCarried ? "yes" : "no"}`,
		`- progress pointer: \`--pointer rescue=${pointer}\``,
	];
	if (manifest.rescues.length > 0) {
		lines.push("", "## Rescue refs (pushed to origin and verified)");
		for (const rescue of manifest.rescues) {
			lines.push(
				`- ${rescue.kind}: \`${rescue.remoteBranch}\` @ \`${rescue.tip}\` (local \`${rescue.localRef}\`)`,
			);
		}
	}
	if (manifest.snapshot) {
		lines.push(
			"",
			"## Uncommitted work snapshot",
			`- staged layer: \`${manifest.snapshot.stagedCommit}\``,
			`- worktree layer: \`${manifest.snapshot.worktreeCommit}\``,
		);
		if (manifest.headBefore === manifest.target) {
			const staged = manifest.snapshot.stagedCommit;
			const work = manifest.snapshot.worktreeCommit;
			lines.push(
				"",
				"Restore (same-phase successor only; skip an empty layer):",
			);
			if (staged !== manifest.headBefore) {
				lines.push(
					"```sh",
					`git diff --binary ${manifest.headBefore} ${staged} | git apply --index`,
					"```",
				);
			}
			if (work !== staged) {
				lines.push(
					"```sh",
					`git diff --binary ${staged} ${work} | git apply`,
					"```",
				);
			}
		}
	}
	if (manifest.nestedMoves.length > 0) {
		lines.push("", "## Nested repositories moved out of the worktree");
		for (const move of manifest.nestedMoves) {
			lines.push(
				`- \`${move.relPath}\` → \`${move.destination}\` (${move.mode}, HEAD ${move.head ?? "none"})`,
			);
			if (manifest.headBefore === manifest.target) {
				lines.push(
					move.mode === "worktree_move"
						? `  restore: \`git -C ${quote(move.destination)} worktree move ${quote(move.destination)} ${quote(move.source)}\``
						: `  restore: \`mv ${quote(move.destination)} ${quote(move.source)}\``,
				);
			}
		}
	}
	return `${lines.join("\n")}\n`;
}
