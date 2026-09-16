import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	return store;
}
const input = {
	operationId: "op-1",
	requestDigest: "a".repeat(64),
	projectName: "raya",
	leadId: "raya",
	leadKey: "raya-raya",
	identityDigest: "identity",
	summaryAssignmentDigest: "summary",
	actor: "bridge-local-operator",
	reason: "raise effort",
	preProjectsSha: "before",
	postProjectsSha: "after",
	preimage: { model: "gpt-6-astra", effort: "low" },
	postimage: { model: "gpt-6-astra", effort: "high" },
	configDigest: "config",
	modelRegistryRevision: "models",
};
it("durably prepares one generation and replays the same intent", async () => {
	const store = await fixture();
	const first = store.prepareLeadConfigOperation(input);
	expect(first).toMatchObject({
		status: "prepared",
		configGeneration: 1,
		input,
	});
	expect(store.prepareLeadConfigOperation(input)).toEqual(first);
	expect(store.listLeadConfigAudit(input.operationId)).toHaveLength(1);
	expect(() =>
		store.prepareLeadConfigOperation({ ...input, reason: "different" }),
	).toThrow("operation_id_conflict");
});
it("refuses a second same-target intent until the prepared operation is reconciled", async () => {
	const store = await fixture();
	store.prepareLeadConfigOperation(input);
	expect(() =>
		store.prepareLeadConfigOperation({ ...input, operationId: "op-2" }),
	).toThrow("lead_config_recovery_required");
	store.transitionLeadConfigOperation(
		input.operationId,
		"prepared",
		"conflict",
		{ reason: "source drift" },
	);
	expect(
		store.prepareLeadConfigOperation({ ...input, operationId: "op-2" }),
	).toMatchObject({ configGeneration: 2 });
});
it("guards the state machine and appends transitions in the same transaction", async () => {
	const store = await fixture();
	store.prepareLeadConfigOperation(input);
	expect(() =>
		store.transitionLeadConfigOperation(
			input.operationId,
			"prepared",
			"observed",
			{},
		),
	).toThrow("invalid_lead_config_transition");
	store.transitionLeadConfigOperation(
		input.operationId,
		"prepared",
		"registry_committed",
		{ projectsSha: "after" },
	);
	expect(() =>
		store.transitionLeadConfigOperation(
			input.operationId,
			"prepared",
			"conflict",
			{},
		),
	).toThrow("lead_config_status_conflict");
	store.transitionLeadConfigOperation(
		input.operationId,
		"registry_committed",
		"pending_runtime",
		{},
	);
	expect(store.listLeadConfigAudit(input.operationId)).toHaveLength(3);
});
it("does not advance status when audit persistence fails", async () => {
	const store = await fixture();
	store.prepareLeadConfigOperation(input);
	const db = (store as unknown as { db: { run(sql: string): void } }).db;
	db.run(
		"CREATE TRIGGER fail_lead_audit BEFORE INSERT ON lead_config_audit BEGIN SELECT RAISE(ABORT, 'audit_failed'); END",
	);
	expect(() =>
		store.transitionLeadConfigOperation(
			input.operationId,
			"prepared",
			"registry_committed",
			{},
		),
	).toThrow("audit_failed");
	expect(store.getLeadConfigOperation(input.operationId)?.status).toBe(
		"prepared",
	);
});

it("preserves prepared recovery intent, immutable inputs and append-only audits across reopen", async () => {
	const root = mkdtempSync(join(tmpdir(), "lead-config-ledger-"));
	roots.push(root);
	const path = join(root, "teamlead.db");
	const first = await StateStore.create(path);
	try {
		first.prepareLeadConfigOperation(input);
	} finally {
		first.close();
	}
	const reopened = await StateStore.create(path);
	stores.push(reopened);
	expect(reopened.listPendingLeadConfigOperations()).toMatchObject([
		{ input, status: "prepared", configGeneration: 1 },
	]);
	const db = (reopened as unknown as { db: { run(sql: string): void } }).db;
	expect(() =>
		db.run("UPDATE lead_config_operation SET input_json = '{}' "),
	).toThrow("immutable");
	expect(() =>
		db.run(
			"INSERT OR REPLACE INTO lead_config_operation SELECT * FROM lead_config_operation",
		),
	).toThrow("cannot be replaced");
	expect(() => db.run("DELETE FROM lead_config_audit")).toThrow("append-only");
	expect(() =>
		db.run(
			"INSERT OR REPLACE INTO lead_config_audit SELECT * FROM lead_config_audit",
		),
	).toThrow("append-only");
});
