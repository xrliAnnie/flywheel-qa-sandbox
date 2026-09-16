import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";

const key = {
	projectName: "flywheel",
	leadId: "product",
	operationId: "linear.comment.create",
	requestId: "123e4567-e89b-42d3-a456-426614174000",
};
const input = {
	...key,
	inputDigest: "a".repeat(64),
	activationId: "activation-1",
	now: 100,
};
const dirs: string[] = [];
const stores: SqliteJournalStore[] = [];
function open(path = ":memory:") {
	const store = new SqliteJournalStore(path);
	stores.push(store);
	return store;
}
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("operation receipts in the existing lead journal", () => {
	it("atomically prepares one composite key and rejects changed input", () => {
		const r = open().operationReceipts;
		expect(r.prepare(input).disposition).toBe("prepared");
		expect(r.prepare(input).disposition).toBe("replay");
		expect(() => r.prepare({ ...input, inputDigest: "b".repeat(64) })).toThrow(
			"input_digest_conflict",
		);
		expect(r.prepare({ ...input, leadId: "other" }).disposition).toBe(
			"prepared",
		);
		expect(r.prepare({ ...input, projectName: "other" }).disposition).toBe(
			"prepared",
		);
		expect(
			r.prepare({ ...input, operationId: "github.pr.comment" }).disposition,
		).toBe("prepared");
	});
	it("binds transitions to digest, activation and state, with no blind retry", () => {
		const r = open().operationReceipts;
		r.prepare(input);
		expect(
			r.prepare({ ...input, activationId: "activation-2" }).disposition,
		).toBe("reconcile-only");
		expect(() =>
			r.transition({
				...input,
				activationId: "activation-2",
				from: "prepared",
				to: "dispatched",
			}),
		).toThrow("receipt_transition_conflict");
		r.transition({ ...input, from: "prepared", to: "dispatched" });
		r.transition({
			...input,
			from: "dispatched",
			to: "unknown",
			errorCode: "provider_timeout",
		});
		expect(() =>
			r.transition({ ...input, from: "unknown", to: "dispatched" }),
		).toThrow("invalid_receipt_transition");
		r.transition({
			...input,
			from: "unknown",
			to: "succeeded",
			providerRef: "comment:123",
		});
		expect(r.get(key)?.providerRef).toBe("comment:123");
		expect(() =>
			r.transition({ ...input, from: "succeeded", to: "dispatched" }),
		).toThrow("invalid_receipt_transition");
	});
	it("migrates/reopens without touching existing journal and recovers dispatched as unknown", () => {
		const dir = mkdtempSync(join(tmpdir(), "lead-receipts-"));
		dirs.push(dir);
		const path = join(dir, "journal.db");
		const raw = new Database(path);
		raw.exec(
			"CREATE TABLE legacy_evidence (id TEXT PRIMARY KEY); INSERT INTO legacy_evidence VALUES ('preserved')",
		);
		raw.close();
		const first = open(path);
		first.operationReceipts.prepare(input);
		first.operationReceipts.transition({
			...input,
			from: "prepared",
			to: "dispatched",
		});
		first.close();
		stores.pop();
		const second = open(path);
		expect(
			second.operationReceipts.recoverDispatched({
				projectName: key.projectName,
				leadId: key.leadId,
				activationId: input.activationId,
				now: 200,
			}),
		).toBe(1);
		expect(second.operationReceipts.get(key)?.state).toBe("unknown");
		expect(
			second.operationReceipts.prepare({
				...input,
				activationId: "activation-2",
			}).disposition,
		).toBe("reconcile-only");
		const inspect = new Database(path);
		expect(inspect.prepare("SELECT id FROM legacy_evidence").get()).toEqual({
			id: "preserved",
		});
		inspect.close();
	});
	it("rolls back receipt mutation with the journal transaction and stores no input body", () => {
		const r = open().operationReceipts;
		expect(() =>
			r.transaction(() => {
				r.prepare(input);
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(r.get(key)).toBeUndefined();
		expect(() =>
			r.prepare({ ...input, secret: "DO_NOT_STORE" } as typeof input),
		).toThrow();
		expect(() => r.prepare({ ...input, requestId: "invalid" })).toThrow();
	});
});

it("serializes competing connections and recovery preserves prepared and foreign activation receipts", () => {
	const dir = mkdtempSync(join(tmpdir(), "lead-receipt-race-"));
	dirs.push(dir);
	const path = join(dir, "journal.db");
	const a = open(path).operationReceipts,
		b = open(path).operationReceipts;
	a.prepare(input);
	expect(b.prepare(input).disposition).toBe("replay");
	a.transition({ ...input, from: "prepared", to: "dispatched" });
	expect(() =>
		b.transition({ ...input, from: "prepared", to: "dispatched" }),
	).toThrow("receipt_transition_conflict");
	const second = {
		...input,
		requestId: "123e4567-e89b-42d3-a456-426614174001",
	};
	a.prepare(second);
	expect(
		b.recoverDispatched({
			projectName: key.projectName,
			leadId: key.leadId,
			activationId: "other",
			now: 200,
		}),
	).toBe(0);
	expect(
		b.recoverDispatched({
			projectName: key.projectName,
			leadId: key.leadId,
			activationId: input.activationId,
			now: 200,
		}),
	).toBe(1);
	expect(a.get({ ...key, requestId: second.requestId })?.state).toBe(
		"prepared",
	);
	expect(() =>
		a.transition({
			...input,
			from: "unknown",
			to: "succeeded",
			providerRef: "123",
			now: 150,
		}),
	).toThrow("receipt_transition_conflict");
});
