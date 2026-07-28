/**
 * QA FLY-1518 — independent check of the advisories folded in from the FLY-1500
 * rebase round (plan §2.2 A1-A4). Each case asserts the behaviour a caller
 * observes, not the shape of the implementation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ActionSerializationError,
	type JsonValue,
	Kernel,
	migrateDatabase,
	recordActionIntent,
	recordActionOutcome,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { runRecordedAction } from "../index.js";

const ACTOR = {
	kind: "lead" as const,
	agentId: "lead-qa",
	instanceId: "instance-1",
	generation: 1,
};

describe("QA FLY-1518 advisories", () => {
	let dir: string | undefined;
	let kernel: Kernel | undefined;

	afterEach(() => {
		kernel?.close();
		kernel = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	function boot(): Kernel {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1518-advisories-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		const opened = Kernel.open({ path });
		kernel = opened;
		opened.write("qa.seed-agent", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-qa','lead',1,'online')`,
			);
		});
		return opened;
	}

	function spec(overrides: Record<string, unknown> = {}) {
		return {
			id: `action-${Object.keys(overrides).length}-${overrides.id ?? "base"}`,
			actor: ACTOR,
			kind: "qa.tool",
			payload: { ok: true },
			logicalEffectId: "effect-1",
			invocationUid: "uid-1",
			cutoverEpoch: 1,
			...overrides,
		} as never;
	}

	const actionRows = (k: Kernel) =>
		k.read((tx) =>
			tx.all<{
				id: string;
				state: string;
				result: string | null;
				authorization: string | null;
			}>("SELECT id, state, result, authorization FROM actions"),
		);

	it("A1 refuses a supersede that reuses the predecessor invocation uid", () => {
		const k = boot();
		const first = k.write("qa.intent", (tx) =>
			recordActionIntent(tx, spec({ id: "action-first" })),
		);
		expect(first.outcome).toBe("inserted");

		// Reusing the uid hashes to the same effect key, so the replay branch would
		// swallow the supersede and lose its retry evidence. It must fail loudly.
		expect(() =>
			k.write("qa.supersede", (tx) =>
				recordActionIntent(
					tx,
					spec({
						id: "action-successor",
						supersedesActionId: first.action.id,
						retryBasis: {
							evidenceRef: "qa://evidence/1",
							reason: "qa rerun after confirmed non-delivery",
						},
					}),
				),
			),
		).toThrow(/invocation/i);

		expect(actionRows(k).map((row) => row.id)).toEqual([first.action.id]);
	});

	it("A2 terminalizes an unserializable result honestly instead of stranding it", async () => {
		const k = boot();

		const result = await runRecordedAction({
			kernel: k,
			action: spec({ id: "action-date" }),
			// The effect really happened; only its summary cannot be canonicalized.
			perform: () =>
				new Date("2026-07-28T00:00:00.000Z") as unknown as JsonValue,
		});

		expect(result.disposition).toBe("performed");
		const row = actionRows(k)[0];
		// Leaving the row at 'intended' would claim the effect never happened —
		// exactly the lie A2 exists to prevent.
		expect(row.state).toBe("succeeded");
		const parsed = JSON.parse(row.result as string);
		expect(parsed.serialization_error).toBeDefined();
		expect(parsed.value_kind).toBe("Date");
	});

	it("A2b lets a real CAS failure surface instead of faking serialization", () => {
		const k = boot();
		const intent = k.write("qa.intent", (tx) =>
			recordActionIntent(tx, spec({ id: "action-cas" })),
		);
		if (intent.outcome !== "inserted") throw new Error("expected inserted");
		k.write("qa.outcome", (tx) =>
			recordActionOutcome(tx, {
				id: intent.action.id,
				actor: ACTOR,
				state: "succeeded",
				result: { ok: true },
			}),
		);

		let thrown: unknown;
		try {
			k.write("qa.outcome-again", (tx) =>
				recordActionOutcome(tx, {
					id: intent.action.id,
					actor: ACTOR,
					state: "failed",
					result: { ok: false },
				}),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeDefined();
		expect(thrown).not.toBeInstanceOf(ActionSerializationError);
		expect(actionRows(k)[0].state).toBe("succeeded");
	});

	it("A3 rejects a non-canonical explicit createdAt", () => {
		const k = boot();
		expect(() =>
			k.write("qa.intent", (tx) =>
				recordActionIntent(
					tx,
					spec({ id: "action-time", createdAt: "2026-07-28 00:00:00" }),
				),
			),
		).toThrow(TypeError);
		expect(actionRows(k)).toEqual([]);
	});

	it("A4 replays the original row and never overwrites its authorization", () => {
		const k = boot();
		const first = k.write("qa.intent", (tx) =>
			recordActionIntent(
				tx,
				spec({ id: "action-auth", authorization: { grant: "first" } }),
			),
		);
		if (first.outcome !== "inserted") throw new Error("expected inserted");

		const replay = k.write("qa.intent-again", (tx) =>
			recordActionIntent(
				tx,
				spec({ id: "action-auth-2", authorization: { grant: "second" } }),
			),
		);

		expect(replay.outcome).toBe("replayed");
		expect(replay.action.id).toBe(first.action.id);
		const rows = actionRows(k);
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].authorization as string)).toEqual({
			grant: "first",
		});
	});
});
