import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	auditLegacyConfigs,
	auditPostDeployConfigs,
	type ConfigSnapshot,
	createPreCutoverReceipt,
	FLY2103_FINAL_ROWS,
	FLY2103_MANIFEST_DIGEST,
	FLY2103_PRE_CUTOVER_ORDER_WARNING,
	FLY2103_PRE_CUTOVER_ROWS,
	FLY2103_PROJECTS,
	type MigrationRow,
	runFly2103Migration,
	stageAndApplyMigrationRow,
	validatePreCutoverReceipt,
} from "../../../../scripts/lib/fly2103-project-flag-migration.js";

function sha(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function legacySnapshots(): ConfigSnapshot[] {
	const docsOn = new Set([
		"flywheel",
		"joycon-typeless",
		"personal-assistant",
		"tidal-echo",
	]);
	return FLY2103_PROJECTS.map((projectName) => {
		const config: Record<string, unknown> = {
			project: projectName,
			checkpoints: {
				approve: { enabled: true, timeout_ms: 172_800_000 },
			},
		};
		if (docsOn.has(projectName)) {
			config.doc_flow = { enabled: true, default_department: "engineering" };
		}
		if (projectName === "flywheel") {
			config.pipeline = { dag: true, work_kind: true };
		}
		const content = JSON.stringify(config);
		return {
			projectName,
			path: `/${projectName}/config.yaml`,
			contentSha: sha(content),
			config,
		};
	});
}

function postSnapshots(): ConfigSnapshot[] {
	return legacySnapshots().map((snapshot) => ({
		...snapshot,
		config: { project: snapshot.projectName },
	}));
}

function receipt() {
	return createPreCutoverReceipt({
		configSnapshots: legacySnapshots(),
		dbRealpath: "/tmp/teamlead.db",
		bridgeTarget: "http://127.0.0.1:9876",
		completedAt: "2026-08-28T00:00:00.000Z",
	});
}

describe("FLY-2103 project flag migration", () => {
	it("pins the two phased manifests and their digest", () => {
		expect(FLY2103_PRE_CUTOVER_ROWS).toEqual([
			{ name: "doc_flow", scope: "flywheel", raw: "1" },
			{ name: "doc_flow", scope: "joycon-typeless", raw: "1" },
			{ name: "doc_flow", scope: "personal-assistant", raw: "1" },
			{ name: "doc_flow", scope: "tidal-echo", raw: "1" },
			{ name: "pipeline_dag", scope: "flywheel", raw: "1" },
			{ name: "pipeline_work_kind", scope: "flywheel", raw: "1" },
		]);
		expect(FLY2103_FINAL_ROWS).toEqual([
			...FLY2103_PRE_CUTOVER_ROWS,
			{ name: "ponytail", scope: "*", raw: "0" },
		]);
		expect(FLY2103_MANIFEST_DIGEST).toMatch(/^[a-f0-9]{64}$/);
		expect(FLY2103_PRE_CUTOVER_ORDER_WARNING).toMatch(
			/G1.*before.*config-removal PRs.*main checkout/i,
		);
	});

	it("audits the complete legacy roster bidirectionally", () => {
		expect(auditLegacyConfigs(legacySnapshots())).toEqual({
			configShas: Object.fromEntries(
				legacySnapshots().map((snapshot) => [
					snapshot.projectName,
					snapshot.contentSha,
				]),
			),
			derivedRows: FLY2103_PRE_CUTOVER_ROWS,
		});

		const deletedTooSoon = legacySnapshots();
		delete deletedTooSoon[0]!.config.checkpoints;
		expect(() => auditLegacyConfigs(deletedTooSoon)).toThrow(
			/checkpoint.*legacy enabled/i,
		);

		const unexpected = legacySnapshots();
		unexpected[0]!.config.ponytail = { enabled: true };
		expect(() => auditLegacyConfigs(unexpected)).toThrow(
			/ponytail\.enabled.*unexpected/i,
		);
	});

	it("requires post-deploy configs to have every retired key removed", () => {
		expect(() => auditPostDeployConfigs(postSnapshots())).not.toThrow();
		const stale = postSnapshots();
		stale[1]!.config.doc_flow = { enabled: true };
		expect(() => auditPostDeployConfigs(stale)).toThrow(
			/doc_flow\.enabled.*still present/i,
		);
	});

	it("creates and strictly validates a G1 receipt", () => {
		const value = receipt();
		expect(value).toMatchObject({
			schemaVersion: 1,
			issue: "FLY-2103",
			phase: "pre-cutover",
			status: "passed",
			manifestDigest: FLY2103_MANIFEST_DIGEST,
			dbRealpath: "/tmp/teamlead.db",
			bridgeTarget: "http://127.0.0.1:9876",
			exactRows: FLY2103_PRE_CUTOVER_ROWS,
		});
		expect(
			validatePreCutoverReceipt(value, {
				dbRealpath: "/tmp/teamlead.db",
				bridgeTarget: "http://127.0.0.1:9876",
			}),
		).toEqual(value);

		for (const tampered of [
			{ ...value, status: "dry-run" },
			{ ...value, manifestDigest: "0".repeat(64) },
			{ ...value, dbRealpath: "/tmp/other.db" },
			{ ...value, bridgeTarget: "http://127.0.0.1:9999" },
			{
				...value,
				configShas: { ...value.configShas, flywheel: "0".repeat(64) },
			},
		]) {
			expect(() =>
				validatePreCutoverReceipt(tampered, {
					dbRealpath: "/tmp/teamlead.db",
					bridgeTarget: "http://127.0.0.1:9876",
				}),
			).toThrow(/receipt/i);
		}
	});

	it("keeps dry-run read-only and makes same-value apply idempotent", async () => {
		const writeRow = vi.fn(async (_row: MigrationRow) => undefined);
		const writeReceipt = vi.fn(async () => undefined);
		const dry = await runFly2103Migration({
			phase: "pre-cutover",
			apply: false,
			configSnapshots: legacySnapshots(),
			currentRows: [],
			dbRealpath: "/tmp/teamlead.db",
			bridgeTarget: "http://127.0.0.1:9876",
			writeRow,
			readRows: async () => [],
			writeReceipt,
			now: () => new Date("2026-08-28T00:00:00.000Z"),
		});
		expect(dry.actions.every((action) => action.action === "write")).toBe(true);
		expect(writeRow).not.toHaveBeenCalled();
		expect(writeReceipt).not.toHaveBeenCalled();

		await runFly2103Migration({
			phase: "pre-cutover",
			apply: true,
			configSnapshots: legacySnapshots(),
			currentRows: FLY2103_PRE_CUTOVER_ROWS,
			dbRealpath: "/tmp/teamlead.db",
			bridgeTarget: "http://127.0.0.1:9876",
			writeRow,
			readRows: async () => FLY2103_PRE_CUTOVER_ROWS,
			writeReceipt,
			now: () => new Date("2026-08-28T00:00:00.000Z"),
		});
		expect(writeRow).not.toHaveBeenCalled();
		expect(writeReceipt).toHaveBeenCalledTimes(1);
	});

	it("never writes a receipt after a partial apply", async () => {
		const writeReceipt = vi.fn(async () => undefined);
		let calls = 0;
		await expect(
			runFly2103Migration({
				phase: "pre-cutover",
				apply: true,
				configSnapshots: legacySnapshots(),
				currentRows: [],
				dbRealpath: "/tmp/teamlead.db",
				bridgeTarget: "http://127.0.0.1:9876",
				writeRow: async () => {
					calls += 1;
					if (calls === 2) throw new Error("bridge failed");
				},
				readRows: async () => [],
				writeReceipt,
				now: () => new Date(),
			}),
		).rejects.toThrow(/bridge failed/);
		expect(writeReceipt).not.toHaveBeenCalled();
	});

	it("writes each missing row through Bridge stage then apply", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					canonical: { kind: "flag_store" },
					confirmToken: "token",
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			});
		await stageAndApplyMigrationRow(
			{ name: "doc_flow", scope: "flywheel", raw: "1" },
			"http://127.0.0.1:9876",
			fetchFn,
		);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:9876/api/fleet/flag/stage",
		);
		expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body)).toEqual({
			name: "doc_flow",
			to: true,
			project: "flywheel",
			op: "set",
			reason: "FLY-2103 config.yaml flag migration",
		});
		expect(JSON.parse(fetchFn.mock.calls[1]?.[1]?.body)).toEqual({
			canonical: { kind: "flag_store" },
			confirmToken: "token",
		});
	});

	it("rejects conflicts, extras, and post-deploy drift before any write", async () => {
		const writeRow = vi.fn(async () => undefined);
		const base = {
			phase: "post-deploy" as const,
			apply: true,
			configSnapshots: postSnapshots(),
			dbRealpath: "/tmp/teamlead.db",
			bridgeTarget: "http://127.0.0.1:9876",
			receipt: receipt(),
			writeRow,
			readRows: async () => FLY2103_FINAL_ROWS,
			writeReceipt: async () => undefined,
			now: () => new Date(),
		};
		for (const currentRows of [
			[...FLY2103_PRE_CUTOVER_ROWS.slice(1)],
			[
				...FLY2103_PRE_CUTOVER_ROWS,
				{ name: "proofshot", scope: "*", raw: "1" },
			],
			FLY2103_PRE_CUTOVER_ROWS.map((row, index) =>
				index === 0 ? { ...row, raw: "0" } : row,
			),
		]) {
			await expect(
				runFly2103Migration({ ...base, currentRows }),
			).rejects.toThrow(/exact-set|conflict/i);
		}
		expect(writeRow).not.toHaveBeenCalled();
	});
});
