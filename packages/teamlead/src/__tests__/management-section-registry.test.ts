import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { ManagementChangeCoordinator } from "../bridge/management-change-coordinator.js";
import { composeManagementSnapshot } from "../bridge/management-console-snapshot.js";
import {
	type ManagementSectionProvider,
	ManagementSectionRegistry,
} from "../bridge/management-section-registry.js";
import { ManagementWriterRegistry } from "../bridge/management-writer.js";

const ORIGIN = "http://127.0.0.1:9931";

function audit() {
	const rows: Array<Record<string, unknown>> = [];
	return {
		rows,
		record(row: Record<string, unknown>) {
			rows.push(row);
			return true;
		},
	};
}

describe("management extension section registry", () => {
	let dir: string;
	let values: Record<string, unknown>;
	let revision: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "management-sections-"));
		values = {
			minPercent: 20,
			maxPercent: 80,
			account: "primary",
			order: ["primary", "backup"],
		};
		revision = 1;
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function provider(
		over: Partial<ManagementSectionProvider> = {},
	): ManagementSectionProvider {
		return {
			id: "quota-settings",
			label: "外部配额监控参数",
			fields: [
				{
					id: "minPercent",
					label: "切换阈值",
					help: "低于此比例时切换",
					kind: "number",
				},
				{ id: "maxPercent", label: "恢复阈值", kind: "number" },
				{
					id: "account",
					label: "当前账号",
					kind: "select",
					options: [
						{ id: "primary", label: "主账号" },
						{ id: "backup", label: "备用账号" },
					],
				},
				{
					id: "order",
					label: "切换顺序",
					kind: "order_list",
					options: [
						{ id: "primary", label: "主账号" },
						{ id: "backup", label: "备用账号" },
					],
				},
			],
			read: () => ({ revision: `quota:${revision}`, values: { ...values } }),
			validate: (proposed) =>
				(proposed.minPercent as number) < (proposed.maxPercent as number)
					? null
					: "minPercent must be below maxPercent",
			apply: ({ proposedValues }) => {
				values = { ...proposedValues };
				revision += 1;
				return { status: "applied" };
			},
			...over,
		};
	}

	it("omits empty sections and projects registered typed fields into the aggregate snapshot", () => {
		const empty = new ManagementSectionRegistry();
		expect(
			composeManagementSnapshot({ providers: [empty.snapshotProvider()] })
				.extensions,
		).toEqual([]);

		const registry = new ManagementSectionRegistry([provider()]);
		const snapshot = composeManagementSnapshot({
			providers: [registry.snapshotProvider()],
		});
		expect(snapshot.extensions).toEqual([
			expect.objectContaining({
				id: "quota-settings",
				label: "外部配额监控参数",
				fields: [
					expect.objectContaining({
						id: "minPercent",
						kind: "number",
						value: expect.objectContaining({ current: 20 }),
					}),
					expect.objectContaining({ kind: "number" }),
					expect.objectContaining({ kind: "select" }),
					expect.objectContaining({ kind: "order_list" }),
				],
			}),
		]);
	});

	it("rejects duplicate sections/fields and unsupported field kinds at registration", () => {
		const registry = new ManagementSectionRegistry([provider()]);
		expect(() => registry.register(provider())).toThrow(/duplicate section/);
		expect(
			() =>
				new ManagementSectionRegistry([
					provider({
						id: "duplicate-fields",
						fields: [
							{ id: "same", label: "A", kind: "boolean" },
							{ id: "same", label: "B", kind: "boolean" },
						],
					}),
				]),
		).toThrow(/duplicate field/);
		expect(
			() =>
				new ManagementSectionRegistry([
					provider({
						id: "raw-json",
						fields: [{ id: "raw", label: "Raw", kind: "json" as never }],
					}),
				]),
		).toThrow(/unsupported field kind/);
	});

	it("turns fields into standard targets and blocks an invalid cross-field batch before mutation", async () => {
		const registry = new ManagementSectionRegistry([provider()]);
		const snapshot = composeManagementSnapshot({
			providers: [registry.snapshotProvider()],
		});
		const fields = snapshot.extensions[0]!.fields;
		const min = fields.find((field) => field.id === "minPercent")!.value;
		const max = fields.find((field) => field.id === "maxPercent")!.value;
		const coordinator = new ManagementChangeCoordinator({
			registry: new ManagementWriterRegistry([registry.writer()]),
			tokens: new ConfirmTokenStore(),
			audit: audit() as never,
			journalDir: dir,
			snapshotRevision: () => snapshot.snapshotRevision,
		});
		const result = await coordinator.stage(
			{
				changes: [
					{
						targetId: min.targetId,
						desiredValue: 90,
						observedRevision: min.source.revision,
					},
					{
						targetId: max.targetId,
						desiredValue: 80,
						observedRevision: max.source.revision,
					},
				],
			},
			ORIGIN,
		);
		expect(result).toMatchObject({
			code: 400,
			body: { error: "minPercent must be below maxPercent" },
		});
		expect(values).toMatchObject({ minPercent: 20, maxPercent: 80 });
		expect(coordinator.listProgress()).toEqual([]);
	});

	it("applies a valid provider batch through the common journal", async () => {
		const registry = new ManagementSectionRegistry([provider()]);
		const snapshot = composeManagementSnapshot({
			providers: [registry.snapshotProvider()],
		});
		const min = snapshot.extensions[0]!.fields.find(
			(field) => field.id === "minPercent",
		)!.value;
		const coordinator = new ManagementChangeCoordinator({
			registry: new ManagementWriterRegistry([registry.writer()]),
			tokens: new ConfirmTokenStore(),
			audit: audit() as never,
			journalDir: dir,
			snapshotRevision: () => snapshot.snapshotRevision,
		});
		const staged = await coordinator.stage(
			{
				changes: [
					{
						targetId: min.targetId,
						desiredValue: 30,
						observedRevision: min.source.revision,
					},
				],
			},
			ORIGIN,
		);
		const applied = await coordinator.apply(staged.body as never, ORIGIN);
		expect(applied).toMatchObject({ code: 200, body: { status: "applied" } });
		expect(values.minPercent).toBe(30);
		expect(coordinator.listProgress()[0]).toMatchObject({
			status: "applied",
			items: [{ targetId: min.targetId, status: "applied" }],
		});
	});

	it("records provider rollback results in the same per-item journal", async () => {
		const registry = new ManagementSectionRegistry([
			provider({
				apply: () => ({ status: "partial", reason: "runtime apply failed" }),
				rollback: () => ({ status: "rolled_back", reason: "restored" }),
			}),
		]);
		const snapshot = composeManagementSnapshot({
			providers: [registry.snapshotProvider()],
		});
		const account = snapshot.extensions[0]!.fields.find(
			(field) => field.id === "account",
		)!.value;
		const coordinator = new ManagementChangeCoordinator({
			registry: new ManagementWriterRegistry([registry.writer()]),
			tokens: new ConfirmTokenStore(),
			audit: audit() as never,
			journalDir: dir,
			snapshotRevision: () => snapshot.snapshotRevision,
		});
		const staged = await coordinator.stage(
			{
				changes: [
					{
						targetId: account.targetId,
						desiredValue: "backup",
						observedRevision: account.source.revision,
					},
				],
			},
			ORIGIN,
		);
		const applied = await coordinator.apply(staged.body as never, ORIGIN);
		expect(applied).toMatchObject({ code: 200, body: { status: "failed" } });
		expect(coordinator.listProgress()[0]!.items[0]).toMatchObject({
			status: "rolled_back",
			reason: "restored",
		});
	});
});
