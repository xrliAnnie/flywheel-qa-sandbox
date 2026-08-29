/**
 * FLY-222: `flywheel-comm xhs-state <subcommand>` — the skill's CLI into the
 * xiaohongshu-state helper. All MUTATING subcommands run their read-modify-write
 * inside the collection-scoped mkdir-mutex; read-only ones take a lock-free
 * snapshot. Output is JSON on stdout so the skill can parse it.
 *
 * Subcommands:
 *   read           --project --collection
 *   diff           --project --collection --note-ids <json array>
 *   is-due         --project --collection
 *   acquire-lease  --project --collection --owner [--ttl-ms]
 *   renew-lease    --project --collection --owner [--ttl-ms]
 *   release-lease  --project --collection --owner
 *   mark-processed --project --collection --note-id
 *   record-pending --project --collection --note-ids <json array>
 *   set-next-due   --project --collection --cadence
 *   record-op-intent --project --collection --note-id --kind --candidate-id
 *   record-feedback-op-intent --project --collection --note-id --action close|create --target <opId|candidateId> [--owner]
 *   mark-op-done   --project --collection --op-id [--issue-id]
 *   find-op        --project --collection --op-id
 *   record-analysis-delivered --project --collection --run-token --report-token --owner   (FLY-286)
 *   clear-pending-feedback    --project --collection --run-token --owner                  (FLY-286)
 *
 * Common: --state-dir overrides the default (else FLYWHEEL_XHS_STATE_DIR / ~).
 */

import { parseArgs } from "node:util";
import {
	acquireLease,
	clearPendingFeedback,
	computeNewNoteIds,
	computeNextDueAt,
	defaultStateDir,
	dropPending,
	findOperation,
	isDue,
	markBootstrapped,
	markOperationDone,
	markProcessed,
	readState,
	recordAnalysisDelivered,
	recordFeedbackOperationIntent,
	recordOperationIntent,
	recordPending,
	releaseLease,
	renewLease,
	withCollectionLock,
	writeState,
	type XiaohongshuFeedbackAction,
	type XiaohongshuOutputKind,
	type XiaohongshuState,
} from "../xiaohongshu-state.js";

const OUTPUT_KINDS = new Set<XiaohongshuOutputKind>(["issue", "memory"]);

interface CommonOpts {
	stateDir: string;
	project: string;
	collection: string;
}

function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(msg: string): never {
	process.stderr.write(`xhs-state: ${msg}\n`);
	process.exit(2);
}

function parseNoteIds(raw: string | undefined): string[] {
	if (!raw) fail("--note-ids <json array of strings> is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw as string);
	} catch {
		fail("--note-ids must be a JSON array of strings");
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every((x) => typeof x === "string" && x.length > 0)
	) {
		fail("--note-ids must be a JSON array of non-empty strings");
	}
	return parsed as string[];
}

/**
 * Run a mutating transition under the collection mutex: read → transform →
 * (optionally write). `transform` returns the next state plus an optional
 * `output` to emit; returning `write: false` skips the write (e.g. rejected
 * lease acquire) so a no-op never rewrites the file. Returns the CLI exit code.
 *
 * F2 owner-fencing (Codex option-A review #2 / qa-fly-222): when `fenceOwner` is
 * set and a DIFFERENT owner holds the lease, the write is REJECTED (exit 2, no
 * mutation) — so a stale/zombie Runner whose lease was taken over cannot still
 * advance processed/pending/operations. Data-mutating subcommands pass
 * `fenceOwner` (the Runner's RUN_KEY); lease ops do their own owner CAS in-lib
 * and pass only `owner` (lock metadata). When no `fenceOwner`/no lease, behavior
 * is unchanged (the scheduler's lease-less triggerIssueId path stays valid).
 */
async function mutate(
	c: CommonOpts,
	transform: (s: XiaohongshuState) => {
		state: XiaohongshuState;
		write: boolean;
		output: unknown;
	},
	opts: { owner?: string; fenceOwner?: string } = {},
): Promise<number> {
	const result = await withCollectionLock(
		c.stateDir,
		c.project,
		c.collection,
		() => {
			const current = readState(c.stateDir, c.project, c.collection);
			// Owner-fence: when a fenceOwner is given, the caller MUST currently
			// hold the lease. Rejecting only on a *different-owner* lease left a hole
			// (codex r3 HIGH): after a stale-takeover Runner B finished and RELEASED
			// the lease (lease=null), a resurrected zombie A would pass the fence and
			// corrupt state. So require an EXISTING lease owned by fenceOwner — reject
			// if there is no lease at all, too. (The scheduler path passes no
			// fenceOwner and is unaffected.)
			if (
				opts.fenceOwner &&
				(!current.lease || current.lease.owner !== opts.fenceOwner)
			) {
				return {
					fenced: true as const,
					heldBy: current.lease?.owner ?? null,
				};
			}
			const { state, write, output } = transform(current);
			if (write) writeState(c.stateDir, state);
			return { fenced: false as const, output };
		},
		opts.owner ? { owner: opts.owner } : {},
	);
	if (result.fenced) {
		emit({ ok: false, reason: "not_lease_owner", heldBy: result.heldBy });
		return 2;
	}
	emit(result.output);
	return 0;
}

export async function xhsState(argv: string[]): Promise<number> {
	const sub = argv[0];
	if (!sub) fail("a subcommand is required");
	const { values } = parseArgs({
		args: argv.slice(1),
		options: {
			project: { type: "string" },
			collection: { type: "string" },
			"state-dir": { type: "string" },
			owner: { type: "string" },
			"note-id": { type: "string" },
			"note-ids": { type: "string" },
			"ttl-ms": { type: "string" },
			cadence: { type: "string" },
			kind: { type: "string" },
			"candidate-id": { type: "string" },
			"op-id": { type: "string" },
			"issue-id": { type: "string" },
			action: { type: "string" },
			target: { type: "string" },
			"run-token": { type: "string" },
			"report-token": { type: "string" },
		},
		allowPositionals: false,
	});

	if (!values.project) fail("--project is required");
	if (!values.collection) fail("--collection is required");
	const c: CommonOpts = {
		stateDir: values["state-dir"]?.trim() || defaultStateDir(),
		project: values.project,
		collection: values.collection,
	};
	const ttlMs = values["ttl-ms"] ? Number(values["ttl-ms"]) : undefined;
	if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
		fail("--ttl-ms must be a positive number");
	}

	switch (sub) {
		case "read":
			emit(readState(c.stateDir, c.project, c.collection));
			return 0;

		case "is-due":
			emit({ due: isDue(readState(c.stateDir, c.project, c.collection)) });
			return 0;

		case "diff": {
			const noteIds = parseNoteIds(values["note-ids"]);
			const s = readState(c.stateDir, c.project, c.collection);
			emit({ new: computeNewNoteIds(noteIds, s) });
			return 0;
		}

		case "acquire-lease": {
			if (!values.owner) fail("--owner is required");
			await mutate(
				c,
				(s) => {
					const r = acquireLease(s, values.owner as string, new Date(), ttlMs);
					return {
						state: r.state,
						write: r.ok,
						output: {
							ok: r.ok,
							reason: r.reason,
							heldBy: r.heldBy,
							lease: r.state.lease,
						},
					};
				},
				{ owner: values.owner },
			);
			return 0;
		}

		case "renew-lease": {
			if (!values.owner) fail("--owner is required");
			await mutate(
				c,
				(s) => {
					const r = renewLease(s, values.owner as string, new Date(), ttlMs);
					return {
						state: r.state,
						write: r.ok,
						output: { ok: r.ok, reason: r.reason },
					};
				},
				{ owner: values.owner },
			);
			return 0;
		}

		case "release-lease": {
			if (!values.owner) fail("--owner is required");
			await mutate(
				c,
				(s) => {
					const r = releaseLease(s, values.owner as string);
					return {
						state: r.state,
						write: r.ok,
						output: { ok: r.ok, reason: r.reason },
					};
				},
				{ owner: values.owner },
			);
			return 0;
		}

		case "mark-processed": {
			const noteId = values["note-id"];
			if (!noteId) fail("--note-id is required");
			return await mutate(
				c,
				(s) => ({
					state: markProcessed(s, noteId),
					write: true,
					output: { ok: true },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "drop-pending": {
			const noteId = values["note-id"];
			if (!noteId) fail("--note-id is required");
			return await mutate(
				c,
				(s) => ({
					state: dropPending(s, noteId),
					write: true,
					output: { ok: true },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "set-bootstrapped": {
			// Mark the first-run baseline done (set even on an empty window, so a
			// later first batch of notes is not mis-baselined). Idempotent.
			return await mutate(
				c,
				(s) => ({
					state: markBootstrapped(s),
					write: true,
					output: { ok: true, bootstrapped: true },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "record-pending": {
			const noteIds = parseNoteIds(values["note-ids"]);
			return await mutate(
				c,
				(s) => ({
					state: recordPending(s, noteIds),
					write: true,
					output: { ok: true },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "set-next-due": {
			const cadence = values.cadence;
			if (!cadence) fail("--cadence is required");
			let nextDueAt: string;
			try {
				nextDueAt = computeNextDueAt(cadence);
			} catch (err) {
				fail((err as Error).message);
			}
			return await mutate(
				c,
				(s) => ({
					state: { ...s, nextDueAt },
					write: true,
					output: { ok: true, nextDueAt },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "record-op-intent": {
			const noteId = values["note-id"];
			const kind = values.kind as XiaohongshuOutputKind | undefined;
			const candidateId = values["candidate-id"];
			if (!noteId) fail("--note-id is required");
			if (!kind || !OUTPUT_KINDS.has(kind))
				fail(`--kind must be one of ${[...OUTPUT_KINDS].join(", ")}`);
			if (!candidateId) fail("--candidate-id is required");
			return await mutate(
				c,
				(s) => {
					const r = recordOperationIntent(s, {
						noteId,
						outputKind: kind,
						candidateId,
					});
					return {
						state: r.state,
						write: true,
						output: { ok: true, opId: r.id },
					};
				},
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "record-feedback-op-intent": {
			// FLY-286: persist a colon-safe feedback action intent (close/create)
			// BEFORE applying it externally. `--target` may itself be a
			// colon-delimited op id; recordFeedbackOperationIntent hashes it into
			// a colon-safe key (codex R2 watchpoint #1).
			const noteId = values["note-id"];
			const action = values.action as XiaohongshuFeedbackAction | undefined;
			const target = values.target;
			if (!noteId) fail("--note-id is required");
			if (action !== "close" && action !== "create")
				fail("--action must be one of close, create");
			if (!target) fail("--target is required");
			return await mutate(
				c,
				(s) => {
					const r = recordFeedbackOperationIntent(s, {
						noteId,
						action,
						target,
					});
					return {
						state: r.state,
						write: true,
						output: { ok: true, opId: r.id },
					};
				},
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "mark-op-done": {
			const opId = values["op-id"];
			if (!opId) fail("--op-id is required");
			return await mutate(
				c,
				(s) => {
					if (!findOperation(s, opId))
						fail(`unknown op-id ${opId} (record intent first)`);
					return {
						state: markOperationDone(
							s,
							opId,
							values["issue-id"] ? { issueId: values["issue-id"] } : {},
						),
						write: true,
						output: { ok: true },
					};
				},
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "find-op": {
			const opId = values["op-id"];
			if (!opId) fail("--op-id is required");
			const rec = findOperation(
				readState(c.stateDir, c.project, c.collection),
				opId,
			);
			emit({ found: rec != null, record: rec ?? null });
			return 0;
		}

		case "record-analysis-delivered": {
			// FLY-286: set lastAnalysisRunToken/lastReportToken + enqueue the run for
			// feedback (owner-fenced; called by the deliver CLI after artifacts).
			const runToken = values["run-token"];
			const reportToken = values["report-token"];
			if (!runToken) fail("--run-token is required");
			if (!reportToken) fail("--report-token is required");
			// --owner is REQUIRED: without it `fenceOwner` is undefined and mutate()
			// skips the lease fence entirely (codex code R1#1).
			if (!values.owner) fail("--owner is required");
			return await mutate(
				c,
				(s) => ({
					state: recordAnalysisDelivered(s, { runToken, reportToken }),
					write: true,
					output: { ok: true },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		case "clear-pending-feedback": {
			// FLY-286: drop a fully-consumed run from the pending-feedback queue.
			const runToken = values["run-token"];
			if (!runToken) fail("--run-token is required");
			if (!values.owner) fail("--owner is required"); // else fence is skipped (R1#1)
			return await mutate(
				c,
				(s) => ({
					state: clearPendingFeedback(s, runToken),
					write: true,
					output: { ok: true },
				}),
				{ owner: values.owner, fenceOwner: values.owner },
			);
		}

		default:
			fail(`unknown subcommand "${sub}"`);
	}
}
