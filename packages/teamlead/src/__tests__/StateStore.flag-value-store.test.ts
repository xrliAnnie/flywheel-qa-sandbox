import { STORE_MANAGED_FLAGS } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore FLY-1778 flag value store", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	function rawDb(): {
		exec(sql: string): void;
		prepare(sql: string): { all(...params: unknown[]): unknown[] };
	} {
		return (
			store as unknown as {
				db: {
					raw: {
						exec(sql: string): void;
						prepare(sql: string): { all(...params: unknown[]): unknown[] };
					};
				};
			}
		).db.raw;
	}

	it("migrates the value, changelog, and single-key meta schema idempotently", () => {
		store.migrate();
		const rows = rawDb()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'flag_%'",
			)
			.all() as Array<{ name: string }>;
		const tables = new Set(rows.map(({ name }) => name));
		for (const table of [
			"flag_values",
			"flag_value_changelog",
			"flag_store_meta",
		]) {
			expect(tables.has(table), table).toBe(true);
		}
		expect(() =>
			rawDb().exec(
				"INSERT INTO flag_store_meta(key,value,updated_at) VALUES ('anything_else',1,1)",
			),
		).toThrow();
	});

	it("seeds exact raw presence with a null value clock and one changelog row", () => {
		store.ensureFlagValueRows({
			env: {
				FLYWHEEL_FLAG_RETIREMENT_SCAN: "",
				FLYWHEEL_WORKFLOW_REWORK_REENTRY: "0",
				FLYWHEEL_SKILL_FRAMEWORK_MODE: "invalid",
				FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: undefined,
			},
			now: 100,
		});
		expect(store.getFlagValueRow("flag_retirement_scan")).toMatchObject({
			hasOverride: true,
			raw: "",
			lastEffective: "true",
			valueLastChanged: null,
			revision: 1,
		});
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({
			hasOverride: false,
			raw: null,
			lastEffective: "false",
			valueLastChanged: null,
			revision: 1,
		});
		expect(store.listFlagValueChanges("skill_framework_mode")).toEqual([
			expect.objectContaining({
				action: "seed",
				toPresent: true,
				toRaw: "invalid",
				toEffective: "superpowers",
			}),
		]);
	});

	it("seeds every store-managed registry flag and its audit origin", () => {
		expect(STORE_MANAGED_FLAGS.size).toBeGreaterThan(0);
		store.ensureFlagValueRows({ env: {}, now: 100 });

		for (const name of STORE_MANAGED_FLAGS) {
			expect(store.getFlagValueRow(name), name).toMatchObject({
				flagName: name,
				revision: 1,
			});
			expect(store.listFlagValueChanges(name), name).toEqual([
				expect.objectContaining({
					flagName: name,
					action: "seed",
				}),
			]);
		}
	});

	it("advances revision on every write but the value clock only on effective change", () => {
		store.ensureFlagValueRows({ env: {}, now: 100 });
		const first = store.applyFlagValueChange({
			name: "flag_retirement_scan",
			rawTo: "1",
			expectedRevision: 1,
			actor: "bridge-local-operator",
			reason: "make the default explicit",
			now: 200,
		});
		expect(first).toMatchObject({ ok: true, valueChanged: false });
		expect(store.getFlagValueRow("flag_retirement_scan")).toMatchObject({
			hasOverride: true,
			raw: "1",
			valueLastChanged: null,
			revision: 2,
		});

		const second = store.applyFlagValueChange({
			name: "flag_retirement_scan",
			rawTo: "0",
			expectedRevision: 2,
			actor: "bridge-local-operator",
			reason: "pause retirement scan",
			now: 300,
		});
		expect(second).toMatchObject({ ok: true, valueChanged: true });
		expect(store.getFlagValueRow("flag_retirement_scan")).toMatchObject({
			lastEffective: "false",
			valueLastChanged: 300,
			revision: 3,
		});

		const third = store.applyFlagValueChange({
			name: "flag_retirement_scan",
			rawTo: "0",
			expectedRevision: 3,
			actor: "bridge-local-operator",
			reason: "repeat operator intent",
			now: 400,
		});
		expect(third).toMatchObject({ ok: true, valueChanged: false });
		expect(store.getFlagValueRow("flag_retirement_scan")).toMatchObject({
			valueLastChanged: 300,
			revision: 4,
		});
	});

	it("clear preserves the row and CAS rejects a stale reviewed revision", () => {
		store.ensureFlagValueRows({
			env: { FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1" },
			now: 100,
		});
		expect(
			store.applyFlagValueChange({
				name: "workflow_turn_divergence_alerts",
				rawTo: null,
				expectedRevision: 1,
				actor: "bridge-local-operator",
				reason: "return to default",
				now: 200,
			}),
		).toMatchObject({ ok: true, valueChanged: true });
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({
			hasOverride: false,
			raw: null,
			revision: 2,
		});
		expect(
			store.applyFlagValueChange({
				name: "workflow_turn_divergence_alerts",
				rawTo: "1",
				expectedRevision: 1,
				actor: "bridge-local-operator",
				reason: "stale retry",
				now: 300,
			}),
		).toEqual({ ok: false, reason: "stale_revision", currentRevision: 2 });
	});

	it("boot reconciliation records a default shift as an observed value change", () => {
		store.ensureFlagValueRows({ env: {}, now: 100 });
		rawDb().exec(
			"UPDATE flag_values SET last_effective='false' WHERE flag_name='flag_retirement_scan'",
		);
		store.ensureFlagValueRows({ env: {}, now: 500 });
		expect(store.getFlagValueRow("flag_retirement_scan")).toMatchObject({
			lastEffective: "true",
			valueLastChanged: 500,
			revision: 2,
		});
		expect(
			store.listFlagValueChanges("flag_retirement_scan").at(-1),
		).toMatchObject({
			action: "default_shift",
			fromEffective: "false",
			toEffective: "true",
		});
	});

	it("mutator independently rejects unlisted and retired identities", () => {
		store.ensureFlagValueRows({ env: {}, now: 100 });
		for (const [name, reason] of [
			["voice_qa_presence_override", "not_store_managed"],
			["workflow_resume", "retired_flag"],
			["three_stage", "retired_flag"],
		] as const) {
			expect(
				store.applyFlagValueChange({
					name,
					rawTo: "1",
					expectedRevision: 1,
					actor: "bridge-local-operator",
					reason: "must be refused",
					now: 200,
				}),
			).toEqual({ ok: false, reason });
		}
	});

	it("rolls back the value write when changelog insertion fails", () => {
		store.ensureFlagValueRows({ env: {}, now: 100 });
		rawDb().exec(`
			CREATE TRIGGER reject_flag_changelog
			BEFORE INSERT ON flag_value_changelog
			BEGIN SELECT RAISE(ABORT, 'forced changelog failure'); END
		`);
		expect(() =>
			store.applyFlagValueChange({
				name: "workflow_turn_divergence_alerts",
				rawTo: "1",
				expectedRevision: 1,
				actor: "bridge-local-operator",
				reason: "prove transaction",
				now: 200,
			}),
		).toThrow(/forced changelog failure/);
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({
			hasOverride: false,
			lastEffective: "false",
			valueLastChanged: null,
			revision: 1,
		});
	});
});
