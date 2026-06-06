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
 *   mark-op-done   --project --collection --op-id [--issue-id]
 *   find-op        --project --collection --op-id
 *
 * Common: --state-dir overrides the default (else FLYWHEEL_XHS_STATE_DIR / ~).
 */

import { parseArgs } from "node:util";
import {
	acquireLease,
	computeNewNoteIds,
	computeNextDueAt,
	defaultStateDir,
	findOperation,
	isDue,
	markOperationDone,
	markProcessed,
	readState,
	recordOperationIntent,
	recordPending,
	releaseLease,
	renewLease,
	withCollectionLock,
	writeState,
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
 * lease acquire) so a no-op never rewrites the file.
 */
async function mutate(
	c: CommonOpts,
	transform: (s: XiaohongshuState) => {
		state: XiaohongshuState;
		write: boolean;
		output: unknown;
	},
	owner?: string,
): Promise<void> {
	const out = await withCollectionLock(
		c.stateDir,
		c.project,
		c.collection,
		() => {
			const current = readState(c.stateDir, c.project, c.collection);
			const { state, write, output } = transform(current);
			if (write) writeState(c.stateDir, state);
			return output;
		},
		owner ? { owner } : {},
	);
	emit(out);
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
						output: { ok: r.ok, reason: r.reason, heldBy: r.heldBy, lease: r.state.lease },
					};
				},
				values.owner,
			);
			return 0;
		}

		case "renew-lease": {
			if (!values.owner) fail("--owner is required");
			await mutate(c, (s) => {
				const r = renewLease(s, values.owner as string, new Date(), ttlMs);
				return { state: r.state, write: r.ok, output: { ok: r.ok, reason: r.reason } };
			}, values.owner);
			return 0;
		}

		case "release-lease": {
			if (!values.owner) fail("--owner is required");
			await mutate(c, (s) => {
				const r = releaseLease(s, values.owner as string);
				return { state: r.state, write: r.ok, output: { ok: r.ok, reason: r.reason } };
			}, values.owner);
			return 0;
		}

		case "mark-processed": {
			const noteId = values["note-id"];
			if (!noteId) fail("--note-id is required");
			await mutate(c, (s) => ({
				state: markProcessed(s, noteId),
				write: true,
				output: { ok: true },
			}));
			return 0;
		}

		case "record-pending": {
			const noteIds = parseNoteIds(values["note-ids"]);
			await mutate(c, (s) => ({
				state: recordPending(s, noteIds),
				write: true,
				output: { ok: true },
			}));
			return 0;
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
			await mutate(c, (s) => ({
				state: { ...s, nextDueAt },
				write: true,
				output: { ok: true, nextDueAt },
			}));
			return 0;
		}

		case "record-op-intent": {
			const noteId = values["note-id"];
			const kind = values.kind as XiaohongshuOutputKind | undefined;
			const candidateId = values["candidate-id"];
			if (!noteId) fail("--note-id is required");
			if (!kind || !OUTPUT_KINDS.has(kind))
				fail(`--kind must be one of ${[...OUTPUT_KINDS].join(", ")}`);
			if (!candidateId) fail("--candidate-id is required");
			await mutate(c, (s) => {
				const r = recordOperationIntent(s, {
					noteId,
					outputKind: kind,
					candidateId,
				});
				return { state: r.state, write: true, output: { ok: true, opId: r.id } };
			});
			return 0;
		}

		case "mark-op-done": {
			const opId = values["op-id"];
			if (!opId) fail("--op-id is required");
			await mutate(c, (s) => {
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
			});
			return 0;
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

		default:
			fail(`unknown subcommand "${sub}"`);
	}
}
